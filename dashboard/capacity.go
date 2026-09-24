package main

// A capacity oracle for CI.
//
// The PR-capsule workflow used to decide whether a new capsule would fit by
// SSHing into the k3s server and counting worker nodes. That answers a
// different question from the one being asked - a node count says nothing
// about free memory - and it needed the deploy key and a shell on the host to
// ask it. The dashboard already collects exactly this, so it answers instead,
// over a small HTTP endpoint the workflow reaches with "kubectl exec ... curl".
//
// The listener binds to loopback and is deliberately NOT exposed through a
// Service or the Ingress: the only way to reach it is from inside this pod,
// which means the caller already holds cluster credentials good enough to exec
// into it. That is the whole authorization story, and it is why this endpoint
// carries no session check of its own.

import (
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// A capsule's footprint is not the figure it currently reports: it grows after
// start, the kubelet keeps its own reserves, and page cache is charged to the
// pod. Planning against the raw number packs a node to the point where the
// next capsule cannot actually land. Declared here and published to the
// browser in the dashboard payload, so the page and this endpoint can never
// disagree about what "fits" means.
const CapsuleHeadroom = 0.15

// EffectiveMiB is the size a capsule really occupies. It never returns 0
// because the dashboard divides free memory by it to draw "fits N more"
// (see effectiveSize in dashboard/static/index.html); Go only compares with
// it, but the two must agree.
func EffectiveMiB(mib int) int {
	if mib < 0 {
		mib = 0
	}
	v := int(math.Ceil(float64(mib) * (1 + CapsuleHeadroom)))
	if v < 1 {
		return 1
	}
	return v
}

// The collector's most recent view of the fleet. The endpoint reports what the
// dashboard itself is showing rather than querying Kubernetes again, so the
// two can never give different answers to the same question.
var (
	latestMu   sync.RWMutex
	latestData *DashboardData
	latestAt   time.Time
)

func publishSnapshot(d DashboardData) {
	latestMu.Lock()
	defer latestMu.Unlock()
	copied := d
	latestData = &copied
	latestAt = time.Now()
}

func snapshot() (*DashboardData, time.Time) {
	latestMu.RLock()
	defer latestMu.RUnlock()
	return latestData, latestAt
}

// FreeForSchedulingMiB is how much memory a NEW pod can take on this node
// without pushing it into eviction. Two budgets bind, and the smaller wins:
//
//	physical    (RamTotal - RamUsed) - reserved
//	schedulable RamAllocatable - podsUsed
//
// The "- reserved" in the first is the part that was missing, and it is what
// took a node down. The reserve is not a budget that gets spent; it is a FLOOR
// that has to stay free. system-reserved and kube-reserved keep the kubelet
// and the OS alive, and the eviction threshold on top of them is the margin
// below which the kubelet starts killing pods. Planning against raw physical
// free space offers that floor out as if it were usable, so filling a node to
// "zero free" means filling it past the point where eviction begins - which is
// exactly what happened.
//
// The second budget catches the opposite case: pods can exhaust what the
// kubelet is willing to hand out while plenty of memory still looks physically
// free, because the reserve is untouched.
func FreeForSchedulingMiB(h HostState) int {
	if h.RamTotal <= 0 || h.RamAllocatable <= 0 {
		return 0
	}
	podsUsed := 0
	for _, c := range h.Capsules {
		podsUsed += c.Ram
	}

	physical := (h.RamTotal - h.RamUsed) - ReservedMiB(h)
	schedulable := h.RamAllocatable - podsUsed
	free := physical
	if schedulable < free {
		free = schedulable
	}
	if free < 0 {
		return 0
	}
	return free
}

// ReservedMiB is the slice of capacity the kubelet holds back and will never
// give to a pod. Reported so the number is visible rather than showing up as
// memory that mysteriously cannot be used.
func ReservedMiB(h HostState) int {
	if h.RamTotal <= 0 || h.RamAllocatable <= 0 {
		return 0
	}
	if r := h.RamTotal - h.RamAllocatable; r > 0 {
		return r
	}
	return 0
}

// A capsule the oracle has promised a node to, but which is not yet visible in
// the cluster. The collector samples every two seconds and a capsule takes far
// longer than that to appear, so without this two pull requests asking at the
// same moment are both told the same node - each measuring a fleet that does
// not yet contain the other's capsule.
//
// This is what lets PR pipelines run concurrently again. Serialising them
// repo-wide also closed the race, but GitHub cancels PENDING runs in a
// concurrency group, so a teardown queued behind another PR's deploy was
// silently dropped and its namespace - holding a clone of the production
// database - leaked forever.
type reservation struct {
	node    string
	mib     int
	expires time.Time
}

// Reservations are held only long enough for a capsule to become measurable.
// Too short and the race reopens; too long and a failed deploy keeps a node
// artificially full. A capsule that has not appeared in five minutes is not
// coming.
const reservationTTL = 5 * time.Minute

var (
	reservationsMu sync.Mutex
	reservations   = map[string]*reservation{}
)

// reserve records an intent against a node, keyed by the caller's own id so a
// pipeline that asks twice replaces its own reservation instead of stacking a
// second one on top.
func reserve(key, node string, mib int) {
	reservationsMu.Lock()
	defer reservationsMu.Unlock()
	reservations[key] = &reservation{node: node, mib: mib, expires: time.Now().Add(reservationTTL)}
}

// reservedOn totals the outstanding promises against one node, dropping any
// that have expired.
//
// exceptKey is the caller's own id, and skipping it is not an optimisation:
// the PR workflow asks up to three times, and after adding a worker it polls
// eight more. Counting a caller's own earlier promise against it would make
// every one of those retries answer "no" - the reservation would break the
// exact flow it exists to protect.
func reservedOn(node, exceptKey string) int {
	reservationsMu.Lock()
	defer reservationsMu.Unlock()
	now := time.Now()
	total := 0
	for k, r := range reservations {
		if now.After(r.expires) {
			delete(reservations, k)
			continue
		}
		if k == exceptKey {
			continue
		}
		if r.node == node {
			total += r.mib
		}
	}
	return total
}

func releaseReservation(key string) {
	reservationsMu.Lock()
	defer reservationsMu.Unlock()
	delete(reservations, key)
}

type placement struct {
	Fits        bool
	Node        string
	FreeMiB     int
	RequiredMiB int
}

// Picks the node with the most free memory that can take a capsule of the
// given size. Deliberately the SAME rule the dashboard draws: the capsule is
// measured at its effective size, not its requested one.
func planPlacement(d *DashboardData, requestMiB int, callerKey string) placement {
	required := EffectiveMiB(requestMiB)
	best := placement{RequiredMiB: required}
	for _, h := range d.Hosts {
		// Two ways a node looks like the best target while being the worst
		// one, both of which only appear once the fleet has more than one
		// node. A node the scale-down job is draining reports full capacity
		// and near-zero usage, so it wins on free memory - and a capsule
		// pinned to it stays Pending forever, because it is cordoned. A node
		// metrics-server has lost reports zero usage for the same reason, and
		// is equally attractive while possibly being full.
		// A node whose allocatable the API has not reported is one whose real
		// budget is unknown, and guessing it as capacity is exactly the
		// mistake that filled a node past its eviction threshold.
		if !h.Schedulable || !h.MetricsKnown || h.RamAllocatable <= 0 {
			continue
		}
		// Memory already promised to a capsule that has not appeared yet is
		// not free, however empty the node currently measures.
		free := FreeForSchedulingMiB(h) - reservedOn(h.ID, callerKey)
		if free < 0 {
			free = 0
		}
		if free > best.FreeMiB {
			best.FreeMiB = free
			best.Node = h.ID
		}
	}
	best.Fits = best.Node != "" && best.FreeMiB >= required
	return best
}

// largestCapsuleMiB is the default request size: "can this node take another
// capsule like the ones already running?" - the same question the dashboard's
// "fits N more" answers.
func largestCapsuleMiB(d *DashboardData) int {
	largest := 0
	for _, h := range d.Hosts {
		for _, c := range h.Capsules {
			if c.Ram > largest {
				largest = c.Ram
			}
		}
	}
	return largest
}

// Plain text, one verdict per line, so a shell can read it without a JSON
// parser: the first line is the answer, everything after it is detail.
func handleCapacity(w http.ResponseWriter, r *http.Request) {
	d, at := snapshot()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")

	if d == nil {
		// Never guess "yes" from no data: a wrong yes puts a capsule on a node
		// that cannot hold it, which fails later and less clearly.
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, "unknown\nreason=no fleet data collected yet\n")
		return
	}
	// Stale data is as dangerous as no data - the collector runs every two
	// seconds, so anything this old means it is wedged or the API is down.
	if age := time.Since(at); age > 2*time.Minute {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "unknown\nreason=fleet data is %ds old\n", int(age.Seconds()))
		return
	}

	requested := 0
	if raw := r.URL.Query().Get("mib"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "unknown\nreason=malformed mib parameter %q\n", raw)
			return
		}
		requested = parsed
	} else {
		requested = largestCapsuleMiB(d)
	}

	// The caller identifies itself with ?for=<pr-env> so its own outstanding
	// promise does not count against it on a retry.
	callerKey := r.URL.Query().Get("for")
	p := planPlacement(d, requested, callerKey)
	verdict := "no"
	if p.Fits {
		verdict = "yes"
		// A "yes" is a promise, so hold the node until the capsule shows up.
		// An anonymous caller is keyed by node, which still stops a second
		// anonymous caller being handed the same node in the same window.
		key := callerKey
		if key == "" {
			key = "anon:" + p.Node
		}
		reserve(key, p.Node, p.RequiredMiB)
	}
	reserved := 0
	for _, h := range d.Hosts {
		if h.ID == p.Node {
			reserved = ReservedMiB(h)
		}
	}
	fmt.Fprintf(w, "%s\nnode=%s\nfree_mib=%d\nreserved_mib=%d\nrequested_mib=%d\nrequired_mib=%d\nheadroom_pct=%d\n",
		verdict, p.Node, p.FreeMiB, reserved, requested, p.RequiredMiB, int(CapsuleHeadroom*100))
}

// startCapacityServer runs the oracle on its own listener, separate from the
// public one, so nothing about it can be reached through the Ingress.
func startCapacityServer() {
	addr := os.Getenv("CAPACITY_ADDR")
	if addr == "" {
		addr = "127.0.0.1:9090"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/capacity", handleCapacity)
	// Lets a pipeline hand a node back when its deploy failed, instead of
	// leaving the node looking full until the reservation ages out.
	mux.HandleFunc("/release", func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get("for")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if key == "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, "missing 'for' parameter\n")
			return
		}
		releaseReservation(key)
		fmt.Fprint(w, "released\n")
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok\n")
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
	}

	go func() {
		log.Printf("capacity oracle listening on %s", addr)
		if err := server.ListenAndServe(); err != nil {
			// Not fatal: the dashboard's own job is unaffected, and failing
			// the whole pod over a CI helper would be worse than losing it.
			log.Println("capacity oracle stopped:", err)
		}
	}()
}
