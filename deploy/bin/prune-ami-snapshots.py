#!/usr/bin/env python2.7

# This script searches an AWS account for EBS snapshots that belong to
# AMIs that are no longer registered. It can be used for pruning
# unused EBS snapshots.

import argparse
import re

import boto3
import concurrent.futures as futures


RE_CREATED_AMI = re.compile('Created by CreateImage\([^\)]+\) for (?P<ami>[^\s+]+)')
RE_COPIED_AMI = re.compile('Copied for DestinationAmi (?P<ami>[^\s+]+)')


def orphaned_ami_snapshots(region, owner_id):
    ec2 = boto3.client('ec2', region_name=region)

    # Only get snapshots owned by us otherwise we can get public snapshots and
    # shared snapshots that aren't ours to manage.
    snapshots = ec2.describe_snapshots(OwnerIds=[owner_id])['Snapshots']

    # If nothing to do, return early. Fetching AMIs is expensive and this
    # saves us a lot of work.
    if not snapshots:
        return {'region': region, 'empty': True}

    # This returns public images and images shared with us. Some EBS snapshots
    # might reference images not owned by us. We don't want to mark snapshots
    # of non-owned images as orphaned, so we return the full list of AMIs here.
    images = ec2.describe_images()['Images']
    amis = set()
    for image in images:
        amis.add(image['ImageId'])

    snapshot_to_ami = {}
    snapshots_by_id = {}
    for snapshot in snapshots:
        snapshots_by_id[snapshot['SnapshotId']] = snapshot

        # We get these for snapshots for an AMI within the local region.
        m = RE_CREATED_AMI.match(snapshot['Description'])
        if m:
            snapshot_to_ami[snapshot['SnapshotId']] = m.group('ami')

        # We get these for snapshots that were copied from an AMI in another
        # region.
        m = RE_COPIED_AMI.match(snapshot['Description'])
        if m:
            snapshot_to_ami[snapshot['SnapshotId']] = m.group('ami')

    unknown_amis = set(snapshot_to_ami.values()) - amis
    orphaned_snapshots = {snapshot for snapshot, ami in snapshot_to_ami.items()
                          if ami in unknown_amis}
    orphaned_size = sum(snapshots_by_id[sid]['VolumeSize']
                        for sid in orphaned_snapshots)

    return {
        'region': region,
        'ami_count': len(images),
        'snapshot_count': len(snapshots),
        'snapshot_to_ami': snapshot_to_ami,
        'snapshots': snapshots_by_id,
        'snapshots_size': sum(s['VolumeSize'] for s in snapshots),
        'snapshots_ami_size': sum(snapshots_by_id[s]['VolumeSize']
                                  for s in snapshot_to_ami.keys()),
        'orphaned_snapshots': orphaned_snapshots,
        'orphaned_size': orphaned_size,
    }


def delete_snapshot(ec2, snap_id):
    print('deleting %s' % snap_id)
    ec2.delete_snapshot(SnapshotId=snap_id)


def main(delete=False, print_orphans=False):
    regions = boto3.session.Session().get_available_regions('ec2')

    owner_id = boto3.client('sts').get_caller_identity()['Account']

    results = []

    with futures.ThreadPoolExecutor(6) as e:
        fs = []
        for region in regions:
            fs.append(e.submit(orphaned_ami_snapshots, region, owner_id))

        total_size = 0
        total_orphaned_size = 0
        total_orphaned_snapshots = 0

        for f in fs:
            res = f.result()

            if 'empty' in res:
                print('%s has no snapshots; ignoring\n' % res['region'])
                continue

            results.append(res)

            print('%s:' % res['region'])
            total_size += res['snapshots_ami_size']
            total_orphaned_size += res['orphaned_size']
            total_orphaned_snapshots += len(res['orphaned_snapshots'])
            print('%d\tAMIs' % res['ami_count'])
            print('%d\tSnapshots' % len(res['snapshots']))
            print('%d\tGB Total snapshot storage' % res['snapshots_size'])
            print('%d\tAMI snapshots' % len(res['snapshot_to_ami']))
            print('%d\tGB Total AMI snapshot storage' % res['snapshots_ami_size'])
            print('%d\tOrphaned AMI snapshots' % len(res['orphaned_snapshots']))
            print('%d\tGB Orphaned AMI snapshot storage' % res['orphaned_size'])
            print('')

            if print_orphans:
                for snap_id in sorted(res['orphaned_snapshots']):
                    snapshot = res['snapshots'][snap_id]
                    print('    %s: (%s) %s' % (snap_id,
                                               snapshot['StartTime'].date().isoformat(),
                                               snapshot['Description']))

    if delete:
        for res in results:
            if not res['orphaned_snapshots']:
                continue

            print('deleting %s snapshots from %s' % (len(res['orphaned_snapshots']),
                                                     res['region']))

            ec2 = boto3.client('ec2', region_name=res['region'])
            ec2.meta.events._unique_id_handlers['retry-config-ec2']['handler']._checker.__dict__['_max_attempts'] = 20

            # This should ideally use a thread pool. However, we quickly run
            # into request limits if we do that and RTT is reasonable. So a
            # single thread/persistent connection is sufficient.
            for snap_id in sorted(res['orphaned_snapshots']):
                delete_snapshot(ec2, snap_id)

    # If we cared enough we could query the pricing API. For now, hardcode
    # a reasonable value.
    total_cost = 0.022 * 12 * total_orphaned_size
    print('')
    print('%d\tGB Total snapshot storage' % total_size)
    print('%d\tTotal orphaned AMI snapshots' % total_orphaned_snapshots)
    print('%d\tGB Total orphaned snapshot storage' % total_orphaned_size)
    print('$%d\tEstimated annual storage cost' % total_cost)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--delete', action='store_true',
                        help='Delete orphan EBS snapshots')
    parser.add_argument('--print-orphans', action='store_true',
                        help='Print information on orphaned snapshots')

    args = parser.parse_args()

    main(delete=args.delete, print_orphans=args.print_orphans)
