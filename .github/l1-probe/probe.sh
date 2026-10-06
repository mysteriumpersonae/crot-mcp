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
VARIANTS="none plain cx stack stackonly stackpeer stackchild stackcx ubu pcomplain bcomplain"
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
payload profile (run 3 adds stackchild/stackcx/ubu and diagnostic variants):
  plain      : px /** -> crot-probe-plain//payload                        (named child, no stack)
  cx         : cx /** -> payload                                          (child, no stack)
  stack      : px /** -> &crot-probe-stack//&crot-probe-stack-payload     (two top-level profiles stacked)
  stackonly  : px /** -> &crot-probe-stackonly-payload                    (stack payload onto bwrap label)
  stackpeer  : as stack, payload allows abstract sockets only to its own label
  stackchild : px /** -> &crot-probe-stackchild//payload                  (stack the CHILD profile onto bwrap label)
  stackcx    : cx /** -> &payload                                         (same, cx syntax)
  ubu        : copy of Ubuntu bwrap-userns-restrict shape (pix, rwlkmix, no abstractions)
  DIAG-pcomplain : as stack, payload profile in complain mode (logs what it would deny)
  DIAG-bcomplain : as stack, bwrap profile in complain mode
  DIAG-envnnp-*  : /usr/bin/env copy (not bwrap) with the stack / plain rule, run with and
                   without setpriv --no-new-privs: separates NNP from bwrap/userns effects
TXT
# printk/audit rate limits would silently drop AppArmor denials
run 'sudo sysctl -w kernel.printk_ratelimit=0 kernel.printk_ratelimit_burst=10000 >/dev/null; sudo auditctl -r 0 2>/dev/null; echo ratelimits-off'
run 'ls /etc/apparmor.d/abi/ 2>&1; ls /etc/apparmor/parser.conf && grep -vE "^\s*#|^\s*$" /etc/apparmor/parser.conf'

# Choose ABI by what the PARSER can compile, not only by the kernel feature.
# (Run 2 chose abi 4.0 + userns rules from the kernel feature alone.)
T=$(mktemp); printf 'abi <abi/4.0>,\nprofile crot-probe-abitest {\n  userns,\n}\n' > $T
PARSER_USERNS=no; out=$(sudo apparmor_parser -Q -K $T 2>&1) && PARSER_USERNS=yes
printf '$ apparmor_parser -Q -K <abi 4.0 + userns test>\n%s\n' "$out"
conc "parser can compile 'abi <abi/4.0>' + 'userns,': $PARSER_USERNS ($(echo "$out" | grep -v '^$' | head -1 | cut -c1-160)); kernel userns_create=$USERNS_FEATURE"
if [ "$USERNS_FEATURE" = yes ] && [ "$PARSER_USERNS" = yes ]; then ABI='abi <abi/4.0>,'; ALLOWUSERNS='userns,'; DENYUSERNS='audit deny userns,'
else ABI='abi <abi/3.0>,'; ALLOWUSERNS=''; DENYUSERNS=''; fi
conc "profiles generated with: $ABI userns-rules=$( [ -n "$ALLOWUSERNS" ] && echo yes || echo no)"

# $1 name, $2 deny|peer|ubu, $3 extra flags (e.g. ",complain"), $4 full label for peer rules (child profiles)
payload() {
  local name="$1" form="$2" fl="$3" peer="${4:-$1}" unixrules files
  files="  include <abstractions/base>
  /{,**} rwlkm,
  /** ix,"
  case "$form" in
    peer) unixrules="  unix (create, bind, listen, accept, getattr, setattr, getopt, setopt, shutdown, receive),
  unix (connect, send) peer=(label=$peer),
  unix (connect, send) peer=(addr=none),";;
    ubu) files="  file rwlkmix /{**,},"; unixrules="  unix,
  audit deny unix (connect, send) peer=(addr=@**),";;
    *) unixrules="  unix,
  audit deny unix (connect, send) peer=(addr=@**),";;
  esac
  cat <<EOF
profile $name flags=(attach_disconnected,mediate_deleted$fl) {
$files
  network,
  mount, umount, pivot_root,
  capability,
  dbus,
  $DENYUSERNS
$unixrules
  signal (send, receive) peer=$peer,
  signal (receive) peer=unconfined,
  ptrace (read, trace) peer=$peer,
}
EOF
}
# $1 name, $2 attach path, $3 transition rule, $4 inner text, $5 extra flags
outer_profile() {
  cat <<EOF
$ABI
include <tunables/global>
profile $1 $2 flags=(attach_disconnected,mediate_deleted$5) {
  # no abstractions/base: its "owner @{HOME}/.Private/** mrixwlk" (ix) conflicts with px (run 1)
  file rwlkm /{,**},
  capability,
  mount, umount, pivot_root,
  network,
  unix,
  signal,
  ptrace,
  dbus,
  $ALLOWUSERNS
  $3
$4
}
EOF
}
LOADED=""
mkp() {   # $1 variant, $2 full policy text
  local f=/etc/apparmor.d/crot-probe-$1 out
  echo "$2" | sudo tee $f >/dev/null
  printf '\n--- %s\n%s\n' "$f" "$2"
  out=$(sudo apparmor_parser -r -W $f 2>&1); local rc=$?
  printf '$ sudo apparmor_parser -r -W %s\n%s\n[exit %s]\n' "$f" "$out" "$rc"
  if sudo grep -q "^crot-probe-$1 " /sys/kernel/security/apparmor/profiles; then conc "profile crot-probe-$1: LOADED"; LOADED="$LOADED $1"
  else conc "profile crot-probe-$1: NOT LOADED rc=$rc parser said: $(echo "$out" | grep -v '^$' | head -3 | tr '\n' '|' | cut -c1-400)"; fi
}
B() { echo "$P/$1/bwrap"; }
mkp plain      "$(outer_profile crot-probe-plain      $(B plain)      'px /** -> crot-probe-plain//payload,' "$(payload payload deny '' crot-probe-plain//payload)")"
mkp cx         "$(outer_profile crot-probe-cx         $(B cx)         'cx /** -> payload,' "$(payload payload deny '' crot-probe-cx//payload)")"
mkp stack      "$(outer_profile crot-probe-stack      $(B stack)      'px /** -> &crot-probe-stack//&crot-probe-stack-payload,' '')
$(payload crot-probe-stack-payload deny)"
mkp stackonly  "$(outer_profile crot-probe-stackonly  $(B stackonly)  'px /** -> &crot-probe-stackonly-payload,' '')
$(payload crot-probe-stackonly-payload deny)"
mkp stackpeer  "$(outer_profile crot-probe-stackpeer  $(B stackpeer)  'px /** -> &crot-probe-stackpeer//&crot-probe-stackpeer-payload,' '')
$(payload crot-probe-stackpeer-payload peer)"
mkp stackchild "$(outer_profile crot-probe-stackchild $(B stackchild) 'px /** -> &crot-probe-stackchild//payload,' "$(payload payload deny '' crot-probe-stackchild//payload)")"
mkp stackcx    "$(outer_profile crot-probe-stackcx    $(B stackcx)    'cx /** -> &payload,' "$(payload payload deny '' crot-probe-stackcx//payload)")"
mkp ubu        "$(outer_profile crot-probe-ubu        $(B ubu)        'allow pix /** -> &crot-probe-ubu//&crot-probe-ubu-payload,' '')
$(payload crot-probe-ubu-payload ubu)"
mkp pcomplain  "$(outer_profile crot-probe-pcomplain  $(B pcomplain)  'px /** -> &crot-probe-pcomplain//&crot-probe-pcomplain-payload,' '')
$(payload crot-probe-pcomplain-payload deny ',complain')"
mkp bcomplain  "$(outer_profile crot-probe-bcomplain  $(B bcomplain)  'px /** -> &crot-probe-bcomplain//&crot-probe-bcomplain-payload,' '' ',complain')
$(payload crot-probe-bcomplain-payload deny)"
mkp envnnps    "$(outer_profile crot-probe-envnnps    $P/envnnps/env  'px /** -> &crot-probe-envnnps//&crot-probe-envnnps-payload,' '')
$(payload crot-probe-envnnps-payload deny)"
mkp envnnpp    "$(outer_profile crot-probe-envnnpp    $P/envnnpp/env  'px /** -> crot-probe-envnnpp//payload,' "$(payload payload deny '' crot-probe-envnnpp//payload)")"
run 'sudo grep crot-probe /sys/kernel/security/apparmor/profiles'

DMN=0
dm_mark() { DMN=$(sudo dmesg 2>/dev/null | wc -l); }
dm_new() {  # AppArmor audit lines since dm_mark, condensed to the decisive fields
  sudo dmesg 2>/dev/null | tail -n +$((DMN+1)) | grep 'apparmor=' | grep -v 'STATUS' | head -8 |
    grep -oE '(apparmor|operation|class|info|error|profile|label|peer|name|comm|requested_mask|denied_mask|requested|denied|target|addr|peer_addr)="[^"]*"|(apparmor|operation|class|info|error|profile|name|comm|requested_mask|denied_mask|target)=[^ "]+' |
    paste -sd' ' | sed 's/apparmor=/\n   apparmor=/g' | cut -c1-600
}
LBL="sh -c 'printf \"label=\"; cat /proc/self/attr/current; echo; grep NoNewPrivs /proc/self/status; python3 -c \"print(\\\"python3-exec-ok\\\")\"'"
WORKING=""
for v in plain cx stack stackonly stackpeer stackchild stackcx ubu pcomplain bcomplain; do
  sec "7.$v transition"
  dm_mark
  out=$(bash -c "$(B $v) $BASIC -- $LBL" 2>&1); rc=$?
  printf '$ %s %s -- <print label, NoNewPrivs, exec python3>\n%s\n[exit %s]\n' "$(B $v)" "$BASIC" "$out" "$rc"
  label=$(echo "$out" | sed -n 's/^label=//p' | head -1)
  $(B $v) $BASIC -- sleep 3 & BP=$!; sleep 1; outer=$(cat /proc/$BP/attr/current 2>&1); wait $BP 2>/dev/null
  if [ $rc -eq 0 ]; then res="STARTED inside=[$label] $(echo "$out" | grep -c python3-exec-ok)x python3-exec-ok"
  else res="FAILED rc=$rc ($(echo "$out" | tail -1))"; fi
  conc "transition $v: outer=[$outer] $res; apparmor audit:$(dm_new)"
  case "$v" in pcomplain|bcomplain) ;; *) [ $rc -eq 0 ] && case "$label" in *payload*) WORKING="$WORKING $v";; esac;; esac
done
for v in envnnps envnnpp; do
  sudo install -D -m 0755 -o root -g root /usr/bin/env $P/$v/env
  for nnp in no yes; do
    dm_mark
    if [ $nnp = yes ]; then cmd="setpriv --no-new-privs $P/$v/env sh -c 'cat /proc/self/attr/current; echo'"; else cmd="$P/$v/env sh -c 'cat /proc/self/attr/current; echo'"; fi
    out=$(bash -c "$cmd" 2>&1); rc=$?
    printf '$ %s\n%s\n[exit %s]\n' "$cmd" "$out" "$rc"
    conc "DIAG $v (env, not bwrap) nnp=$nnp: rc=$rc $(echo "$out" | tail -1 | cut -c1-120); apparmor audit:$(dm_new)"
  done
done
conc "D3: enforcing transitions that reach the payload label under NNP:${WORKING:- NONE}"

# --------------------------------------------------------------------------
BEST=$(for c in stack ubu stackonly stackchild stackcx; do case " $WORKING " in *" $c "*) echo $c; break;; esac; done); BEST=${BEST:-stack}
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
  conc "[$v] nested user namespace from payload: $r (AD-20 p.5: payload does not grant userns; where AppArmor has no userns mediation this behaves as unconfined)"
  r=$(bash -c "$P/$v/bwrap $BASIC --disable-userns -- unshare --user true && echo NESTED-USERNS-ALLOWED || echo NESTED-USERNS-DENIED" 2>&1 | tail -1)
  conc "[$v] nested user namespace with bwrap --disable-userns: $r"
  M=$(mktemp -d); mkdir -p $M/lower $M/up $M/wk; echo lower > $M/lower/f
  r=$(bash -c "$P/$v/bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user --die-with-parent --overlay-src $M/lower --overlay $M/up $M/wk /mnt -- sh -c 'echo changed > /mnt/f && cat /mnt/f'" 2>&1)
  conc "[$v] bwrap --overlay (private home layer mechanism): $r ; lower after=$(cat $M/lower/f) upper=$(cat $M/up/f 2>/dev/null || echo none)"
  # run 1 used pgrep -f "sleep 300", which matched its own bash command line (false SURVIVED)
  $P/$v/bwrap $BASIC -- sh -c 'setsid sleep 3017 & nohup sleep 3018 >/dev/null 2>&1 & echo started' >/dev/null 2>&1
  sleep 1
  r=$(pgrep -fa '^sleep 301[78]$' || echo none)
  [ "$r" = none ] && r="DIED-WITH-SANDBOX" || r="SURVIVED-SANDBOX-EXIT ($r)"
  conc "[$v] setsid/nohup background children after the sandbox leader exits: $r"
  pkill -f '^sleep 301[78]$' 2>/dev/null
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
if sudo grep -q "^crot-probe-container " /sys/kernel/security/apparmor/profiles; then conc "profile crot-probe-container: LOADED in kernel"
else conc "profile crot-probe-container: NOT LOADED (see parser output above)"; fi
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
