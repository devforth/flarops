// The shell both workflows use to reach the k3s server over SSH.
//
// It lives in one module because deploy.yml and pr-capsule.yml had four
// copies of "ssh to the box and cat the kubeconfig" between them, and only
// one of the four waited for the box to be ready. "terraform apply" returns
// when EC2 reports the instance as *running*, which is a minute or two before
// cloud-init has even written authorized_keys and several minutes before k3s
// exists - so an immediate ssh is not flaky, it is reliably too early.
//
// Two waits, not one, and they are different failures:
//
//  * No SSH at all means the instance never booted or is unreachable
//    (security group, wrong key). Retrying past that is pointless once the
//    instance has had ten minutes.
//  * SSH but no /etc/rancher/k3s/k3s.yaml means user_data is still running -
//    or has already failed. The bootstrap script drops a sentinel file when
//    it fails (see templates/terraform.js), so the wait can stop on the spot
//    and print the log instead of sitting out the full timeout and then
//    telling a human to go and ssh in themselves.

// -o BatchMode=yes: without it, a key that is missing or rejected makes ssh
//   fall through to keyboard-interactive and sit there.
// -o UserKnownHostsFile=/dev/null: the Elastic IP outlives the instance it
//   points at, so a deliberately replaced node reuses the address with a new
//   host key. With a known_hosts file that is a hard failure no retry can
//   clear; without one there is nothing to conflict with. Host key pinning
//   would be the alternative, and there is nowhere to pin it from - the key
//   is generated on first boot.
const SSH_OPTS = [
  '-o StrictHostKeyChecking=no',
  '-o UserKnownHostsFile=/dev/null',
  '-o GlobalKnownHostsFile=/dev/null',
  '-o BatchMode=yes',
  '-o LogLevel=ERROR',
  '-o ConnectTimeout=10',
].join(' ');

// How long each wait is allowed to take. Bounded on purpose: an unbounded
// wait here waits out GitHub's six-hour job limit with the EC2 instance
// already created and billing, and every later push queued behind it.
const SSH_ATTEMPTS = 60;   // x 10s = 10 minutes to become reachable
const K3S_ATTEMPTS = 90;   // x 10s = 15 minutes to finish installing k3s

function indentBlock(text, indent) {
  return text.split('\n').map(l => (l === '' ? '' : indent + l)).join('\n');
}

// Shell functions, defined once per `run:` block that needs them.
// Callers use: flarops_wait_for_k3s "$EC2_IP"  and  flarops_ssh "$EC2_IP" "cmd"
function helpers(indent = '          ') {
  return indentBlock(`# --- flarops ssh helpers (see templates/ciSsh.js) ---
flarops_ssh() { ssh ${SSH_OPTS} "ubuntu@$1" "$2"; }

flarops_dump_bootstrap_log() {
  echo "----- $1: /var/log/flarops-bootstrap.log (last 200 lines) -----"
  flarops_ssh "$1" "sudo tail -n 200 /var/log/flarops-bootstrap.log 2>/dev/null || echo '(no bootstrap log - user_data never ran)'" || true
  echo "----- $1: /var/log/cloud-init-output.log (last 100 lines) -----"
  flarops_ssh "$1" "sudo tail -n 100 /var/log/cloud-init-output.log 2>/dev/null || echo '(no cloud-init log)'" || true
}

flarops_wait_for_k3s() {
  FLAROPS_IP="$1"
  echo "Waiting for SSH on $FLAROPS_IP (terraform returns long before cloud-init has run)..."
  FLAROPS_SSH_OK=""
  for attempt in $(seq 1 ${SSH_ATTEMPTS}); do
    if flarops_ssh "$FLAROPS_IP" true; then FLAROPS_SSH_OK=yes; break; fi
    echo "  no SSH yet ($attempt/${SSH_ATTEMPTS})"
    sleep 10
  done
  if [ -z "$FLAROPS_SSH_OK" ]; then
    echo "::error::$FLAROPS_IP never accepted SSH within 10 minutes. The instance exists but is unreachable - check that it booted, that the security group still allows port 22, and that SSH_PRIVATE_KEY matches the key in deploy/terraform/variables.tf."
    return 1
  fi

  echo "Waiting for k3s on $FLAROPS_IP..."
  for attempt in $(seq 1 ${K3S_ATTEMPTS}); do
    if flarops_ssh "$FLAROPS_IP" "sudo test -f /etc/rancher/k3s/k3s.yaml"; then
      echo "k3s is up on $FLAROPS_IP."
      return 0
    fi
    if flarops_ssh "$FLAROPS_IP" "test -f /var/lib/flarops/bootstrap-failed"; then
      echo "::error::The k3s install failed on $FLAROPS_IP. Its log follows."
      flarops_dump_bootstrap_log "$FLAROPS_IP"
      return 1
    fi
    echo "  k3s not ready yet ($attempt/${K3S_ATTEMPTS})"
    sleep 10
  done
  echo "::error::k3s did not finish installing on $FLAROPS_IP within 15 minutes. Its log follows."
  flarops_dump_bootstrap_log "$FLAROPS_IP"
  return 1
}
# --- end flarops ssh helpers ---`, indent);
}

// The whole "get a working kubeconfig into ~/.kube/config" sequence, waits
// included. EC2_IP must already be set by the caller.
function fetchKubeconfig(indent = '          ') {
  return helpers(indent) + '\n' + indentBlock(`
flarops_wait_for_k3s "$EC2_IP"

mkdir -p ~/.kube
flarops_ssh "$EC2_IP" "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
chmod 600 ~/.kube/config

# The server writes its own kubeconfig pointing at 127.0.0.1; from here the
# API server is only reachable at the public address the certificate was
# issued for (--tls-san in user_data).
sed -i "s/127.0.0.1/$EC2_IP/g" ~/.kube/config
# A kubeconfig that reached none of the above is an empty file that every
# later kubectl treats as "no context", which reads as a cluster with nothing
# in it - the exact shape that made a teardown report success while the
# capsule was still running.
test -s ~/.kube/config`, indent);
}

module.exports = { SSH_OPTS, helpers, fetchKubeconfig };
