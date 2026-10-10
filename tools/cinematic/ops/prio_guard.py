#!/usr/bin/env python3
# Author: suwubee
"""Keep a render tree polite to the rest of the (shared) server without starving its own I/O path.

usage: prio_guard.py <render_pid> [--heavy 19] [--every 10]

- GPU process (Mesa llvmpipe rasteriser threads = the CPU hog)   -> nice --heavy (19) + idle I/O class
- everything else in the tree (frame receiver / PNG encoder, browser + renderer, utility) -> unchanged
  These are light but latency-critical: if they are starved by the rasteriser threads, frame uploads back up and Chromium
  dies with ERR_BLOB_OUT_OF_MEMORY (this happened when the whole tree was reniced to +19 while other jobs were running).
Priorities are per thread (Linux setpriority(PRIO_PROCESS, tid)), re-applied every few seconds so restarted workers and
freshly spawned raster threads are covered. Exits when the render process is gone.
"""
import os, sys, time, subprocess

def parse(argv):
    import argparse
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('pid', type=int, nargs='?')
    p.add_argument('--heavy', type=int, choices=range(0,20), default=19)
    p.add_argument('--every', type=int, choices=range(1,61), default=10)
    p.add_argument('--selftest', action='store_true')
    return p.parse_args(argv[1:])

def identity(pid):
    try:
        with open(f'/proc/{pid}/stat') as f:
            s=f.read()
        return (os.stat(f'/proc/{pid}').st_uid, s[s.rindex(')')+2:].split()[19])
    except (OSError, IndexError):
        return None

def ppid_map():
    m = {}
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            with open(f'/proc/{d}/stat', 'rb') as f:
                s = f.read().decode('utf-8', 'replace')
            m[int(d)] = int(s[s.rindex(')') + 2:].split()[1])
        except Exception:
            pass
    return m

def tree(root):
    m = ppid_map(); kids = {}
    for p, pp in m.items():
        kids.setdefault(pp, []).append(p)
    out, stack = [], [root]
    while stack:
        p = stack.pop(); out.append(p); stack.extend(kids.get(p, []))
    return out

def cmdline(pid):
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            return f.read().replace(b'\0', b' ').decode('utf-8', 'replace')
    except Exception:
        return ''

def main():
    a = parse(sys.argv)
    if a.selftest:
        assert identity(os.getpid())[0] == os.getuid()
        assert os.getpid() in tree(os.getpid())
        print('PASS prio_guard identity/tree selftest; no priorities changed')
        return
    root, heavy, every = a.pid, a.heavy, a.every
    root_identity = identity(root)
    if not root_identity or root_identity[0] != os.getuid():
        sys.exit('refusing absent or differently owned PID')
    # Only touch the explicitly supplied, same-user render process and its descendants.
    if 'render_frames.mjs' not in cmdline(root):
        sys.exit(f'refusing: pid {root} is not a render_frames.mjs process ({cmdline(root)[:80]!r})')
    idle_io = set()
    while identity(root) == root_identity:
        for pid in tree(root):
            pid_identity = identity(pid)
            if not pid_identity or pid_identity[0] != os.getuid() or identity(root) != root_identity: continue
            gpu = '--type=gpu-process' in cmdline(pid)
            if not gpu:
                continue
            want = heavy
            try:
                tids = os.listdir(f'/proc/{pid}/task')
            except Exception:
                continue
            for t in tids:
                try:
                    if identity(pid) == pid_identity and os.getpriority(os.PRIO_PROCESS, int(t)) < want:
                        os.setpriority(os.PRIO_PROCESS, int(t), want)
                except Exception:
                    pass
            if gpu and (pid,pid_identity) not in idle_io and identity(pid) == pid_identity:
                idle_io.add((pid,pid_identity))
                subprocess.run(['ionice', '-c3', '-p', str(pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        time.sleep(every)

if __name__ == '__main__':
    main()
