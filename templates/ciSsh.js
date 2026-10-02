// The shell both workflows use to reach the k3s server: wait for SSH, then for k3s (stopping early
// on the bootstrap's failure sentinel), then fetch the kubeconfig.

// BatchMode: never wait at a password prompt. No known_hosts: the Elastic IP outlives the instance it
// points at, so a replaced node reuses the address with a new host key.
const SSH_OPTS = [
  '-o StrictHostKeyChecking=no',
  '-o UserKnownHostsFile=/dev/null',
  '-o GlobalKnownHostsFile=/dev/null',
  '-o BatchMode=yes',
  '-o LogLevel=ERROR',
  '-o ConnectTimeout=10',
].join(' ');

// Bounded: an unbounded wait would hold the job (and a billed instance) for GitHub's six-hour limit.
const SSH_ATTEMPTS = 60;   // x 10s = 10 minutes to become reachable
const K3S_ATTEMPTS = 90;   // x 10s = 15 minutes to finish installing k3s

function indentBlock(text, indent) {
  return text.split('\n').map(l => (l === '' ? '' : indent + l)).join('\n');
}

// Shell functions for one `run:` block: flarops_wait_for_k3s "$EC2_IP", flarops_ssh "$EC2_IP" "cmd".
function helpers(indent = '          ') {
  return indentBlock(`flarops_ssh() { ssh ${SSH_OPTS} "ubuntu@$1" "$2"; }

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
`, indent);
}

function fetchKubeconfig(indent = '          ') {
  return helpers(indent) + '\n' + indentBlock(`
flarops_wait_for_k3s "$EC2_IP"

mkdir -p ~/.kube
flarops_ssh "$EC2_IP" "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
chmod 600 ~/.kube/config

sed -i "s/127.0.0.1/$EC2_IP/g" ~/.kube/config
test -s ~/.kube/config`, indent);
}

module.exports = { SSH_OPTS, helpers, fetchKubeconfig };
