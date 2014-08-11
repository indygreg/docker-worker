/**
Handler of individual tasks beings at claim ends with posting task results.
*/
var debug = require('debug')('runTask');
var request = require('superagent-promise');
var util = require('util');
var waitForEvent = require('./wait_for_event');
var features = require('./features');
var co = require('co');

var DockerProc = require('dockerode-process');
var PassThrough = require('stream').PassThrough;
var States = require('./states');

// We must reclaim somewhat frequently (but not too frequently) this is the
// divisor used to figure out when to issue the reclaim based on taken until for
// example `2` would mean half the time between now and taken until.
var RECLAIM_DIVISOR = 1.3;

var PAYLOAD_SCHEMA =
  'http://schemas.taskcluster.net/docker-worker/v1/payload.json#';

/*
@example

taskEnvToDockerEnv({ FOO: true });
// => ['FOO=true']

@private
@param {Object} env key=value pair for environment variables.
@return {Array} the docker array format for variables
*/
function taskEnvToDockerEnv(env) {
  if (!env || typeof env !== 'object') {
    return env;
  }

  return Object.keys(env).reduce(function(map, name) {
    map.push(name + '=' + env[name]);
    return map;
  }, []);
}


/**
Convert the feature flags into a state handler.

@param {Object} task definition.
*/
function buildStateHandlers(task) {
  var handlers = [];
  var featureFlags = task.payload.features || {};

  for (var flag in features) {
    var enabled = (flag in featureFlags) ?
      featureFlags[flag] : features[flag].defaults;

    if (enabled) {
      handlers.push(new (features[flag].module)());
    }
  }

  return new States(handlers);
}

function Task(runtime, runId, task, status) {
  this.runId = runId;
  this.task = task;
  this.status = status;
  this.runtime = runtime;

  // Primarly log of all actions for the task.
  this.stream = new PassThrough();
  // states actions.
  this.states = buildStateHandlers(task);
}

Task.prototype = {
  /**
  Build the docker container configuration for this task.

  @param {Array[dockerode.Container]} [links] list of dockerode containers.
  */
  dockerConfig: function(links) {
    var config = this.task.payload;
    var env = config.env || {};

    // Universally useful environment variables describing the current task.
    env.TASK_ID = this.status.taskId;
    env.RUN_ID = this.runId;

    var procConfig = {
      start: {},
      create: {
        Image: config.image,
        Cmd: config.command,
        Hostname: '',
        User: '',
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        OpenStdin: false,
        StdinOnce: false,
        Env: taskEnvToDockerEnv(env)
      }
    }

    if (links) {
      procConfig.start.Links = links.map(function(link) {
        return link.name + ':' + link.alias;
      });
    }

    return procConfig;
  },

  fmtLog: function() {
    var args = Array.prototype.slice.call(arguments);
    return '[taskcluster] ' + util.format.apply(this, args) + '\r\n';
  },

  logHeader: function() {
    return this.fmtLog(
      'taskId: %s, workerId: %s \r\n',
      this.status.taskId, this.runtime.workerId
    );
  },

  logFooter: function(success, exitCode, start, finish) {
    // Human readable success/failure thing...
    var humanSuccess = success ?
      'Successful' :
      'Unsuccessful';

    // Yes, date subtraction yields a Number.
    var duration = (finish - start) / 1000;

    return this.fmtLog(
      '%s task run with exit code: %d completed in %d seconds',
      humanSuccess, exitCode, duration
    );
  },

  logSchemaErrors: function(prefix, errors) {
    return this.fmtLog(
      "%s format is invalid json schema errors:\n %s",
      prefix, JSON.stringify(errors, null, 2)
    );
  },

  completeRun: function* (success) {
    yield this.runtime.stats.timeGen(
      'tasks.time.completed',
      this.runtime.queue.reportCompleted(
        this.status.taskId, this.runId, { success: success }
      )
    );
  },

  claimTask: function* () {
    this.runtime.stats.increment('tasks.claims');
    var claimConfig = {
      workerId: this.runtime.workerId,
      workerGroup: this.runtime.workerGroup
    };

    this.claim = yield this.runtime.stats.timeGen(
      'tasks.time.claim',
      this.runtime.queue.claimTask(this.status.taskId, this.runId, claimConfig)
    );

    // Figure out when to issue the next claim...
    var takenUntil = (new Date(this.claim.takenUntil) - new Date())
    var nextClaim = takenUntil / RECLAIM_DIVISOR;

    // This is tricky ensure we have logs...
    this.runtime.log('next claim', {
      taskId: this.status.taskId,
      runId: this.runId,
      time: nextClaim
    });

    // Figure out when we need to make the next claim...
    this.clearClaimTimeout();
    this.claimTimeoutId = setTimeout(co(this.claimTask.bind(this)), nextClaim);
  },

  clearClaimTimeout: function() {
    if (this.claimTimeoutId) {
      clearTimeout(this.claimTimeoutId);
      this.claimTimeoutId = null;
    }
  },

  claimAndRun: function* () {
    // Issue the first claim... This also kicks off the reclaim timers.
    yield this.claimTask();

    this.runtime.log('claim and run', {
      taskId: this.status.taskId,
      runId: this.runId,
      takenUntil: this.claim.takenUntil
    });

    var success;
    try {
      success = yield this.run();
    } catch (e) {
      // TODO: Reconsider if we should mark the task as failed or something else
      //       at this point... I intentionally did not mark the task completed
      //       here as to allow for a retry by another worker, etc...
      this.clearTimeout();
      throw e
    }

    // Called again outside so we don't run this twice in the same try/catch
    // segment potentially causing a loop...
    this.clearClaimTimeout();
    // Mark the task appropriately now that all internal state is cleaned up.
    yield this.completeRun(success);
  },

  /**
  Primary handler for all docker related task activities this handles the
  launching/configuration of all tasks as well as the features for the given
  tasks.

  @return {Boolean} success true/false for complete run.
  */
  run: function* () {
    var taskStart = new Date();
    var stats = this.runtime.stats;
    var queue = this.runtime.queue;

    // Cork all writes to the stream until we are done setting up logs.
    this.stream.cork();

    // Task log header.
    this.stream.write(this.logHeader());

    // Build the list of container links...
    var links =
      yield* stats.timeGen('tasks.time.states.linked', this.states.link(this));

    var dockerProc = this.dockerProcess = new DockerProc(
      this.runtime.docker, this.dockerConfig(links)
    );

    // Pipe the stream into the task handler stream. This has a small
    // performance cost but allows us to send all kinds of additional (non
    // docker) related logs to the "terminal.log" in an ordered fashion.
    dockerProc.stdout.pipe(this.stream, {
      end: false
    });

    // Hooks prior to running the task.
    yield stats.timeGen('tasks.time.states.created', this.states.created(this));

    // At this point all readers of our stream should be attached and we can
    // uncork.
    this.stream.uncork();

    // Validate the schema!
    var payloadErrors =
      this.runtime.schema.validate(this.task.payload, PAYLOAD_SCHEMA);

    if (payloadErrors.length) {
      // Inform the user that this task has failed due to some configuration
      // error on their part.
      this.stream.write(this.logSchemaErrors('`task.payload`', payloadErrors));
      this.stream.write(this.logFooter(
        false, // unsuccessful task
        -1, // negative exit code indicates infrastructure errors usually.
        taskStart, // duration details...
        new Date()
      ));
      //
      return false;
    }

    // start the timer to ensure we don't go overtime.
    var maxRuntimeMS = this.task.payload.maxRunTime * 1000;
    var runtimeTimeoutId = setTimeout(function() {
      stats.increment('tasks.timed_out');
      stats.gauge('tasks.timed_out.max_run_time', this.task.payload.maxRunTime);
      // we don't wait for the promise to resolve just trigger kill here which
      // will cause run below to stop processing the task and give us an error
      // exit code.
      dockerProc.kill();
      this.stream.write(this.fmtLog(
        'Task timeout after %d seconds. Force killing container.',
        this.task.payload.maxRunTime
      ));
    }.bind(this), maxRuntimeMS);

    var exitCode = yield* stats.timeGen('tasks.time.run', dockerProc.run());
    var success = exitCode === 0;

    clearTimeout(runtimeTimeoutId);

    // XXX: Semi-hack to ensure all consumers of the docker proc stdout get the
    // entire contents. Ideally we could just wait for the end cb but that does
    // not seem to help in this case...
    if (!dockerProc.stdout._readableState.endEmitted) {
      // We wait _before_ extractResult so those states hooks can add items
      // to the stream.
      yield waitForEvent(dockerProc.stdout, 'end');
    }

    // Extract any results from the hooks.
    yield stats.timeGen(
      'tasks.time.states.stopped', this.states.stopped(this)
    );

    this.stream.write(this.logFooter(success, exitCode, taskStart, new Date()));

    // Wait for the stream to end entirely before killing remaining containers.
    yield this.stream.end.bind(this.stream);

    // Cleanup all containers.
    yield *stats.timeGen('tasks.time.removed',dockerProc.remove());
    yield stats.timeGen('tasks.time.states.killed', this.states.killed(this));

    // If the results validation failed we consider this task failure.
    return success;
  }
};

module.exports = Task;