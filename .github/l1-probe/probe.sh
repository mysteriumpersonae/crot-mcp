#!/usr/bin/env bash
# WP-23a L1 probe (decisions D3/D4). Diagnostic only; never stops on a failing
# probe. Prints each command, its exit status and output, and one CONCLUSION
# line per probe (repeated in a summary at the end). Only loopback addresses
# are used; no credentials or tokens are printed. Everything it installs lives
# under /opt/crot-probe or /etc/apparmor.d/crot-probe-* on the throwaway runner.
set +e
LABEL="${1:-unknown}"
P=/opt/crot-probe
BWRAP_TAG=v0.11.0
CONC=()

sec()  { printf '\n==================== %s ====================\n' "$1"; }
run()  { printf '\n$ %s\n' "$*"; bash -c "$*" 2>&1; local rc=$?; printf '[exit %s]\n' "$rc"; return $rc; }
conc() { CONC+=("$1"); printf '>>> CONCLUSION: %s\n' "$1"; }

# --------------------------------------------------------------------------
sec "1. RUNNER / ARCH / KERNEL"
echo "runner label (matrix): $LABEL"
run 'uname -srvm'
run 'dpkg --print-architecture'
run '. /etc/os-release; echo "$PRETTY_NAME"'
run 'nproc; free -h | head -2'
run 'id -un; id -u; id -Gn'
conc "label $LABEL started: arch=$(uname -m) kernel=$(uname -r) ubuntu=$(. /etc/os-release; echo $VERSION_ID)"

# --------------------------------------------------------------------------
sec "2. USER NAMESPACES (unconfined caller)"
run 'cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo "(unprivileged_userns_clone absent)"'
run 'cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo "(apparmor_restrict_unprivileged_userns absent)"'
run 'cat /proc/sys/kernel/apparmor_restrict_unprivileged_unconfined 2>/dev/null || echo "(apparmor_restrict_unprivileged_unconfined absent)"'
run 'cat /proc/sys/user/max_user_namespaces'
if run 'unshare --user --map-root-user -- id -u'; then conc "unconfined unshare --user: WORKS"
else conc "unconfined unshare --user: DENIED"; fi

# --------------------------------------------------------------------------
sec "3. OVERLAYFS in an unprivileged user+mount namespace (unconfined caller)"
D=$(mktemp -d); mkdir -p "$D"/{lower,upper,work,merged}; echo lower > "$D/lower/f"
if run "unshare --user --map-root-user --mount -- sh -c 'mount -t overlay overlay -o lowerdir=$D/lower,upperdir=$D/upper,workdir=$D/work $D/merged && echo upper > $D/merged/f && cat $D/merged/f'"; then
  conc "unprivileged overlay via unshare: WORKS (lower=$(cat $D/lower/f) upper=$(cat $D/upper/f 2>/dev/null))"
else conc "unprivileged overlay via unshare: FAILED (userns denied or overlay refused; see above)"; fi

# --------------------------------------------------------------------------
sec "4. APPARMOR STATUS AND FEATURES"
F=/sys/kernel/security/apparmor/features
run 'cat /sys/module/apparmor/parameters/enabled'
run 'apparmor_parser --version | head -1'
run "ls $F"
run "ls $F/namespaces 2>/dev/null || echo '(no namespaces feature dir)'"
run "ls $F/network 2>/dev/null; cat $F/network/af_unix 2>/dev/null || echo '(no network/af_unix)'"
run "ls $F/network_v8 2>/dev/null || echo '(no network_v8)'"
run "ls $F/domain 2>/dev/null; cat $F/domain/stack 2>/dev/null; echo; cat $F/domain/fix_binfmt_elf_mmap 2>/dev/null; true"
run "cat $F/signal/mask 2>/dev/null || echo '(no signal feature)'"
run 'sudo aa-status 2>/dev/null | head -6'
run 'ls /etc/apparmor.d/ | grep -iE "bwrap|unpriv|userns" || echo "(no bwrap/userns profiles shipped)"'
run 'for f in /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/unprivileged_userns; do [ -f "$f" ] && { echo "--- $f"; grep -vE "^\s*#|^\s*$" "$f"; }; done; true'
USERNS_FEATURE=no; [ -e $F/namespaces/userns_create ] && USERNS_FEATURE=yes
AFUNIX=no; [ -e $F/network/af_unix ] && AFUNIX=yes
STACK=no; [ -e $F/domain/stack ] && STACK=yes
conc "AppArmor enabled=$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null) parser=$(apparmor_parser --version 2>/dev/null | head -1 | awk '{print $NF}') userns_create=$USERNS_FEATURE af_unix=$AFUNIX stacking=$STACK"

# --------------------------------------------------------------------------
sec "5. BUBBLEWRAP: distro package, and pinned $BWRAP_TAG built to probe-owned paths"
run 'sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap meson ninja-build libcap-dev pkg-config gcc python3 >/dev/null && echo deps-installed'
run 'dpkg-query -W bubblewrap; /usr/bin/bwrap --version'
run "sudo mkdir -p $P/src && sudo chown \$(id -u) $P/src && curl -fsSL https://github.com/containers/bubblewrap/archive/refs/tags/$BWRAP_TAG.tar.gz | tar -xz -C $P/src --strip-components=1 && cd $P/src && meson setup _b -Dman=disabled -Dtests=false -Dselinux=disabled >/dev/null && ninja -C _b >/dev/null && echo built"
VARIANTS="none plain cx stack stackonly stackpeer"
for v in $VARIANTS; do sudo install -D -m 0755 -o root -g root "$P/src/_b/bwrap" "$P/$v/bwrap"; done
run "$P/none/bwrap --version; ls -l $P/*/bwrap"
run "$P/none/bwrap --help 2>&1 | grep -E 'overlay|disable-userns|assert-userns|die-with-parent|unshare-net|new-session' "
conc "pinned bubblewrap: $( [ -x $P/none/bwrap ] && $P/none/bwrap --version || echo BUILD-FAILED)"

BASIC='--ro-bind / / --dev /dev --proc /proc --unshare-user --unshare-pid --die-with-parent --new-session'
sec "6. CROT-path bubblewrap WITHOUT any profile (baseline)"
if run "$P/none/bwrap $BASIC -- sh -c 'cat /proc/self/attr/current; echo; grep NoNewPrivs /proc/self/status'"; then
  conc "bwrap at $P/none (no profile): userns ALLOWED"
else conc "bwrap at $P/none (no profile): userns DENIED"; fi

# --------------------------------------------------------------------------
sec "7. PROFILE TRANSITIONS UNDER NO_NEW_PRIVS (D3)"
cat <<'TXT'
bubblewrap sets PR_SET_NO_NEW_PRIVS before it execs the payload. One profile is
attached to each binary copy; they differ only in the exec transition into the
payload profile:
  plain     : px /** -> crot-probe-plain//payload                       (named child, px)
  cx        : cx /** -> payload                                         (child, cx)
  stack     : px /** -> &crot-probe-stack//&crot-probe-stack-payload    (form of Ubuntu's bwrap-userns-restrict)
  stackonly : px /** -> &crot-probe-stackonly-payload                   (stack the payload onto the bwrap label)
  stackpeer : as stack, but the payload allows abstract sockets only to its own label (allow-list form)
Payload profiles: everything allowed except: no new userns (where mediated),
connect/send to abstract unix sockets outside the sandbox denied, signals and
ptrace only to the payload's own label (receive from unconfined allowed).
TXT
if [ "$USERNS_FEATURE" = yes ]; then ABI='abi <abi/4.0>,'; ALLOWUSERNS='userns,'; DENYUSERNS='audit deny userns,'
else ABI='abi <abi/3.0>,'; ALLOWUSERNS=''; DENYUSERNS=''; fi

# $1 profile name, $2 "deny"|"peer" abstract-socket form
payload() {
  local name="$1" form="$2" unixrules
  if [ "$form" = peer ]; then
    unixrules="  unix (create, bind, listen, accept, getattr, setattr, getopt, setopt, shutdown, receive),
  unix (connect, send) peer=(label=$name),
  unix (connect, send) peer=(addr=none),"
  else
    unixrules="  unix,
  audit deny unix (connect, send) peer=(addr=@**),"
  fi
  cat <<EOF
profile $name flags=(attach_disconnected,mediate_deleted) {
  include <abstractions/base>
  /{,**} rwlkm,
  /** ix,
  network,
  mount, umount, pivot_root,
  capability,
  dbus,
  $DENYUSERNS
$unixrules
  signal (send, receive) peer=$name,
  signal (receive) peer=unconfined,
  ptrace (read, trace) peer=$name,
}
EOF
}
# $1 variant, $2 transition rule, $3 extra profile text (payload)
bwrap_profile() {
  local v="$1" rule="$2" inner="$3"
  cat <<EOF
$ABI
include <tunables/global>
profile crot-probe-$v $P/$v/bwrap flags=(attach_disconnected,mediate_deleted) {
  include <abstractions/base>
  /{,**} rwlkm,
  capability,
  mount, umount, pivot_root,
  network,
  unix,
  signal,
  ptrace,
  dbus,
  $ALLOWUSERNS
  $rule
$inner
}
EOF
}
mkp() { echo "$2" | sudo tee "/etc/apparmor.d/crot-probe-$1" >/dev/null; printf '\n--- /etc/apparmor.d/crot-probe-%s\n%s\n' "$1" "$2"; run "sudo apparmor_parser -r -W /etc/apparmor.d/crot-probe-$1 && echo loaded-$1"; }

mkp plain "$(bwrap_profile plain 'px /** -> crot-probe-plain//payload,' "$(payload payload deny)")"
mkp cx "$(bwrap_profile cx 'cx /** -> payload,' "$(payload payload deny)")"
mkp stack "$(bwrap_profile stack 'px /** -> &crot-probe-stack//&crot-probe-stack-payload,' '')
$(payload crot-probe-stack-payload deny)"
mkp stackonly "$(bwrap_profile stackonly 'px /** -> &crot-probe-stackonly-payload,' '')
$(payload crot-probe-stackonly-payload deny)"
mkp stackpeer "$(bwrap_profile stackpeer 'px /** -> &crot-probe-stackpeer//&crot-probe-stackpeer-payload,' '')
$(payload crot-probe-stackpeer-payload peer)"
run 'sudo aa-status 2>/dev/null | grep crot-probe'

WORKING=""
for v in plain cx stack stackonly stackpeer; do
  sec "7.$v transition: label and NoNewPrivs inside the sandbox"
  out=$(bash -c "$P/$v/bwrap $BASIC -- sh -c 'printf \"label=\"; cat /proc/self/attr/current; echo; grep NoNewPrivs /proc/self/status'" 2>&1); rc=$?
  printf '$ %s/%s/bwrap %s -- <print label>\n%s\n[exit %s]\n' "$P" "$v" "$BASIC" "$out" "$rc"
  label=$(echo "$out" | sed -n 's/^label=//p' | head -1)
  if [ $rc -eq 0 ]; then conc "transition $v: sandbox STARTED, label inside=[$label]"; else conc "transition $v: sandbox FAILED rc=$rc ($(echo "$out" | tail -1))"; fi
  [ $rc -eq 0 ] && case "$label" in *payload*) WORKING="$WORKING $v";; esac
  run "sudo dmesg 2>/dev/null | grep -i 'apparmor=' | grep crot-probe-$v | tail -3 || true"
done
conc "D3: transitions that reach the payload label under NNP:${WORKING:- NONE}"

# --------------------------------------------------------------------------
BEST=$(echo $WORKING | awk '{print $1}'); BEST=${BEST:-stack}
sec "8. BOUNDARY TESTS inside the payload (variant: $BEST; also stackpeer)"
# Outside listeners: an abstract socket and a pathname socket (both loopback-local).
python3 - <<'PY' &
import socket, os, threading
def serve(addr):
    s = socket.socket(socket.AF_UNIX); s.bind(addr); s.listen(8)
    while True:
        c, _ = s.accept(); c.sendall(b"hello-from-outside\n"); c.close()
for a in ("\0crot-probe-abs", "/tmp/crot-probe.sock"):
    threading.Thread(target=serve, args=(a,), daemon=True).start()
threading.Event().wait(600)
PY
LPID=$!; sleep 2
sleep 600 & OUTSIDE=$!
CLIENT='import socket,sys
a=sys.argv[1]
a="\0"+a[1:] if a.startswith("@") else a
s=socket.socket(socket.AF_UNIX)
try:
    s.connect(a); print("CONNECTED", s.recv(64).decode().strip())
except OSError as e:
    print("REFUSED errno=%d %s" % (e.errno, e.strerror))'
echo "$CLIENT" > /tmp/crot-probe-client.py
cat > /tmp/crot-probe-intra.py <<'PY'
import socket, threading
srv = socket.socket(socket.AF_UNIX); srv.bind("\0crot-probe-inner"); srv.listen(1)
threading.Thread(target=lambda: srv.accept()[0].sendall(b"x"), daemon=True).start()
c = socket.socket(socket.AF_UNIX)
try:
    c.connect("\0crot-probe-inner"); print("INTRA-SANDBOX-CONNECTED", c.recv(1).decode())
except OSError as e:
    print("INTRA-SANDBOX-REFUSED errno=%d" % e.errno)
PY
run "python3 /tmp/crot-probe-client.py @crot-probe-abs   # control: unconfined"
for v in $BEST stackpeer; do
  NET='--ro-bind / / --dev /dev --proc /proc --unshare-user --die-with-parent --new-session'   # host netns shared (network=on), host pid ns visible for the signal test
  r=$(bash -c "$P/$v/bwrap $NET -- python3 /tmp/crot-probe-client.py @crot-probe-abs" 2>&1)
  printf '$ [%s] abstract connect from sandbox (network=on)\n%s\n' "$v" "$r"
  conc "[$v] abstract unix socket outside sandbox, network=on: $r"
  r=$(bash -c "$P/$v/bwrap $NET -- python3 /tmp/crot-probe-client.py /tmp/crot-probe.sock" 2>&1)
  printf '$ [%s] pathname socket connect from sandbox\n%s\n' "$v" "$r"
  conc "[$v] pathname unix socket visible in mount view: $r"
  r=$(bash -c "$P/$v/bwrap $NET --unshare-net -- python3 /tmp/crot-probe-client.py @crot-probe-abs" 2>&1)
  conc "[$v] abstract socket with network=off (own netns): $r"
  r=$(bash -c "$P/$v/bwrap $NET -- sh -c 'kill -0 $OUTSIDE && echo SIGNAL-DELIVERED || echo SIGNAL-DENIED'" 2>&1)
  conc "[$v] signal to an unconfined host process: $r"
  r=$(bash -c "$P/$v/bwrap $NET -- sh -c 'sleep 30 & kill -0 \$! && echo INTRA-SIGNAL-DELIVERED || echo INTRA-SIGNAL-DENIED; kill \$! 2>/dev/null'" 2>&1)
  conc "[$v] signal between two confined processes: $r"
  r=$(bash -c "$P/$v/bwrap $NET -- python3 /tmp/crot-probe-intra.py" 2>&1)
  conc "[$v] abstract socket between two confined processes: $r"
  r=$(bash -c "$P/$v/bwrap $BASIC -- unshare --user true && echo NESTED-USERNS-ALLOWED || echo NESTED-USERNS-DENIED" 2>&1 | tail -1)
  conc "[$v] nested user namespace from payload: $r"
  M=$(mktemp -d); mkdir -p $M/lower $M/up $M/wk; echo lower > $M/lower/f
  r=$(bash -c "$P/$v/bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user --die-with-parent --overlay-src $M/lower --overlay $M/up $M/wk /mnt -- sh -c 'echo changed > /mnt/f && cat /mnt/f'" 2>&1)
  conc "[$v] bwrap --overlay (private home layer mechanism): $r ; lower after=$(cat $M/lower/f) upper=$(cat $M/up/f 2>/dev/null || echo none)"
  r=$(bash -c "$P/$v/bwrap $BASIC -- sh -c 'setsid sh -c \"sleep 300\" & echo started'; sleep 1; pgrep -f \"sleep 300\" >/dev/null && echo SURVIVED-SANDBOX-EXIT || echo DIED-WITH-SANDBOX" 2>&1 | tail -1)
  conc "[$v] setsid background child after the sandbox leader exits: $r"
  pkill -f "sleep 300" 2>/dev/null
done
kill $LPID $OUTSIDE 2>/dev/null

# --------------------------------------------------------------------------
sec "9. DOCKER"
if ! command -v docker >/dev/null; then conc "docker: NOT INSTALLED on this runner image"; else
run 'docker --version; docker version --format "server {{.Server.Version}} api {{.Server.APIVersion}}"'
run 'docker info --format "security={{.SecurityOptions}}" 2>&1 | head -2'
conc "docker: $(docker version --format 'client {{.Client.Version}} server {{.Server.Version}}' 2>&1 | head -1)"
run 'docker pull -q alpine:3 && docker pull -q python:3-alpine'

# 9a: Docker CLI from a confined process through a bound socket (the endpoint shape of AD-20 point 9)
r=$(bash -c "$P/$BEST/bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user --die-with-parent --bind /var/run/docker.sock /var/run/docker.sock -- docker run --rm alpine:3 echo container-ran" 2>&1 | tail -2)
conc "[$BEST] docker run from confined process via bound unix socket: $r"

# 9b: which AppArmor label does the daemon give containers by default?
r=$(docker run --rm alpine:3 cat /proc/1/attr/current 2>&1)
conc "default container label: $r"

# 9c: a CROT-like container profile, loaded on this host
cat <<EOF | sudo tee /etc/apparmor.d/crot-probe-container >/dev/null
$ABI
include <tunables/global>
profile crot-probe-container flags=(attach_disconnected,mediate_deleted) {
  include <abstractions/base>
  network,
  capability,
  file,
  umount,
  signal (receive) peer=unconfined,
  signal (send, receive) peer=crot-probe-container,
  unix,
  audit deny unix (connect, send) peer=(addr=@**),
  deny @{PROC}/sysrq-trigger rwklx,
  deny /sys/kernel/security/** rwklx,
}
EOF
run 'sudo apparmor_parser -r -W /etc/apparmor.d/crot-probe-container && echo loaded-container-profile'
python3 - <<'PY' &
import socket, threading
s = socket.socket(socket.AF_UNIX); s.bind("\0crot-probe-host-abs"); s.listen(8)
while True:
    c, _ = s.accept(); c.sendall(b"hello-host\n"); c.close()
PY
HL=$!; sleep 2
DCLIENT='import socket
s=socket.socket(socket.AF_UNIX)
try:
    s.connect("\0crot-probe-host-abs"); print("CONNECTED", s.recv(32).decode().strip())
except OSError as e:
    print("REFUSED errno=%d" % e.errno)'
r=$(docker run --rm --network host python:3-alpine python3 -c "$DCLIENT" 2>&1 | tail -1)
conc "--network host container, default profile -> host abstract socket: $r"
r=$(docker run --rm --network host --security-opt apparmor=crot-probe-container python:3-alpine python3 -c "$DCLIENT" 2>&1 | tail -1)
conc "--network host container, crot-probe-container -> host abstract socket: $r"
r=$(docker run --rm --security-opt apparmor=crot-probe-container alpine:3 cat /proc/1/attr/current 2>&1 | tail -1)
conc "label with crot-probe-container: $r"
r=$(docker run --rm --security-opt apparmor=crot-probe-does-not-exist alpine:3 true 2>&1 | tail -1)
conc "profile not loaded on the daemon's host (what a remote daemon would do): $(echo "$r" | cut -c1-200)"
kill $HL 2>/dev/null

# 9d: a second local daemon on loopback TCP without TLS (local TCP transport)
run 'sudo bash -c "nohup dockerd -H tcp://127.0.0.1:2399 --data-root /tmp/crot-d2 --exec-root /tmp/crot-e2 --pidfile /tmp/crot-d2.pid --bridge=none --iptables=false --ip6tables=false >/tmp/crot-d2.log 2>&1 &"; sleep 10; echo started'
r=$(DOCKER_HOST=tcp://127.0.0.1:2399 docker version --format 'tcp {{.Server.Version}}' 2>&1 | tail -1)
conc "local TCP daemon (no TLS) reachable: $r"
r=$(DOCKER_HOST=tcp://127.0.0.1:2399 docker info --format '{{.SecurityOptions}}' 2>&1 | tail -1)
conc "local TCP daemon security options: $r"
run 'tail -3 /tmp/crot-d2.log | cut -c1-200'
sudo kill "$(cat /tmp/crot-d2.pid 2>/dev/null)" 2>/dev/null

# 9e: ssh:// transport to this host (where sshd can be started)
run 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null; sudo systemctl start ssh 2>/dev/null || sudo service ssh start 2>/dev/null; systemctl is-active ssh 2>/dev/null || echo not-active'
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/crot_probe <<<y >/dev/null 2>&1
cat ~/.ssh/crot_probe.pub >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys
printf 'Host crot-probe-local\n  HostName 127.0.0.1\n  User %s\n  IdentityFile ~/.ssh/crot_probe\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n' "$(id -un)" >> ~/.ssh/config
r=$(docker -H ssh://crot-probe-local version --format 'ssh {{.Server.Version}}' 2>&1 | tail -1)
conc "ssh:// daemon transport (loopback): $r"
run 'docker context create crot-probe-ctx --docker "host=ssh://crot-probe-local" >/dev/null && docker --context crot-probe-ctx ps -q >/dev/null && echo context-ok; docker context rm -f crot-probe-ctx >/dev/null'
fi

# --------------------------------------------------------------------------
sec "SUMMARY ($LABEL)"
for c in "${CONC[@]}"; do echo " - $c"; done
echo
echo "Interpret from the lines above; the job colour is not evidence."
exit 0
