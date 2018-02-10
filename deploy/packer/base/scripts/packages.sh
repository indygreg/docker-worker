#! /bin/bash

set -e -v

DOCKER_VERSION=17.12.0~ce-0~ubuntu
V4L2LOOPBACK_VERSION=0.10.0

lsb_release -a

# add docker group and add current user to it
sudo groupadd -f docker

# Make sure we use add the calling user to docker
# group. If the the script itself is called with sudo,
# we must use SUDO_USER, otherwise, use USER.

if [ -n "${SUDO_USER}" ]; then
    user=${SUDO_USER}
else
    user=${USER}
fi

sudo usermod -a -G docker $user

sudo apt-get update -y

[ -e /usr/lib/apt/methods/https ] || {
  apt-get install apt-transport-https
}

# Add docker gpg key and update sources
sudo apt-key adv --keyserver hkp://p80.pool.sks-keyservers.net:80 --recv-keys 9DC858229FC7DD38854AE2D88D81803C0EBFCD88
sudo sh -c 'echo "deb [arch=amd64] https://download.docker.com/linux/ubuntu trusty stable" \
  > /etc/apt/sources.list.d/docker.list'

## Update to pick up new registries
sudo apt-get update -y

# Install AWS optimized kernel.
sudo apt-get install -y linux-aws linux-tools-aws

# Remove the virtual package for the old kernel.
sudo apt-get remove -y linux-image-virtual linux-image-extra-virtual linux-headers-virtual

# Purge leftover kernel packages.
old_packages=$(dpkg-query -W -f'${Package}\n' linux-*-generic)
if [ -n "${old_packages}" ]; then
    sudo apt-get -y purge ${old_packages}
fi

sudo apt-get autoremove -y

# Capture the installed kernel version so we can compile kernel modules for
# it below.
KERNEL_VER=$(dpkg --list | grep 'linux-image-[0-9]' | awk '{print $2}' | sed 's/linux-image-//')

if [ -z "${KERNEL_VER}" ]; then
    echo "unable to resolve installed kernel version!"
    exit 1
fi

## Install all the packages
sudo apt-get install -y \
    unattended-upgrades \
    docker-ce=$DOCKER_VERSION \
    dkms \
    lvm2 \
    curl \
    build-essential \
    git-core \
    gstreamer0.10-alsa \
    gstreamer0.10-plugins-bad \
    gstreamer0.10-plugins-base \
    gstreamer0.10-plugins-good \
    gstreamer0.10-plugins-ugly \
    gstreamer0.10-tools \
    pbuilder \
    python-mock \
    python-configobj \
    python-support \
    cdbs \
    python-pip \
    jq \
    rsyslog-gnutls \
    openvpn \
    lxc \
    rng-tools \
    liblz4-tool

# Remove apport because it prevents obtaining crashes from containers
# and because it may send data to Canonical.
sudo apt-get purge -y apport

# Clone and build Zstandard
sudo git clone https://github.com/facebook/zstd /zstd
cd /zstd
# Corresponds to v1.3.3.
sudo git checkout f3a8bd553a865c59f1bd6e1f68bf182cf75a8f00
sudo make zstd
sudo mv zstd /usr/bin
cd /
sudo rm -rf /zstd

if [ -z "${VAGRANT_PROVISION}" ]; then
    ## Clear mounts created in base image so fstab is empty in other builds...
    sudo sh -c 'echo "" > /etc/fstab'
fi

## Install v4l2loopback
cd /usr/src
sudo rm -rf v4l2loopback-$V4L2LOOPBACK_VERSION
sudo git clone --branch v$V4L2LOOPBACK_VERSION https://github.com/umlaeute/v4l2loopback.git v4l2loopback-$V4L2LOOPBACK_VERSION
cd v4l2loopback-$V4L2LOOPBACK_VERSION
sudo dkms install -m v4l2loopback -v $V4L2LOOPBACK_VERSION -k ${KERNEL_VER}
sudo dkms build -m v4l2loopback -v $V4L2LOOPBACK_VERSION -k ${KERNEL_VER}

echo "v4l2loopback" | sudo tee --append /etc/modules

sudo sh -c 'echo "options v4l2loopback devices=100" > /etc/modprobe.d/v4l2loopback.conf'

# Install Audio loopback devices
echo "snd-aloop" | sudo tee --append /etc/modules
sudo sh -c 'echo "options snd-aloop enable=1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1 index=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29" > /etc/modprobe.d/snd-aloop.conf'

# Do one final package cleanup, just in case.
sudo apt-get autoremove -y

# Remove apt packages and lists to free up lots of space.
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*
