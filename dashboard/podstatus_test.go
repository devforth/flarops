package main

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func ownedPod(kind, owner string, phase corev1.PodPhase, created time.Time) *corev1.Pod {
	p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop-production", CreationTimestamp: metav1.NewTime(created)},
		Status: corev1.PodStatus{Phase: phase}}
	if kind != "" {
		p.OwnerReferences = []metav1.OwnerReference{{Kind: kind, Name: owner}}
	}
	return p
}

func TestPodIsDone(t *testing.T) {
	now := time.Now()
	deleting := metav1.NewTime(now)
	evicted := ownedPod("", "", corev1.PodFailed, now)
	evicted.Status.Reason = "Evicted"
	terminating := ownedPod("ReplicaSet", "api-7d9", corev1.PodRunning, now)
	terminating.DeletionTimestamp = &deleting
	succeeded := map[string]time.Time{"shop-production/migrate": now}

	cases := []struct {
		name string
		pod  *corev1.Pod
		want bool
	}{
		{"evicted", evicted, true},
		{"failed under a ReplicaSet, already replaced", ownedPod("ReplicaSet", "api-7d9", corev1.PodFailed, now), true},
		{"failed under a StatefulSet", ownedPod("StatefulSet", "db", corev1.PodFailed, now), true},
		{"being deleted by a deploy", terminating, true},
		{"a failed attempt of a job that then succeeded", ownedPod("Job", "migrate", corev1.PodFailed, now.Add(-time.Minute)), true},
		{"a job's failure after its last success", ownedPod("Job", "migrate", corev1.PodFailed, now.Add(time.Minute)), false},
		{"a failed job that never succeeded", ownedPod("Job", "seed", corev1.PodFailed, now), false},
		{"a bare failed pod", ownedPod("", "", corev1.PodFailed, now), false},
		{"running under a ReplicaSet", ownedPod("ReplicaSet", "api-7d9", corev1.PodRunning, now), false},
	}
	for _, c := range cases {
		if got := podIsDone(c.pod, succeeded); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// Time in status is from the transition into it, not from when the pod was created.
func TestStatusSince(t *testing.T) {
	created := time.Now().Add(-10 * 24 * time.Hour)
	started := metav1.NewTime(created.Add(time.Minute))
	flipped := metav1.NewTime(time.Now().Add(-2 * time.Minute))
	crashed := metav1.NewTime(time.Now().Add(-3 * time.Minute))

	crashing := ownedPod("ReplicaSet", "api", corev1.PodRunning, created)
	crashing.Status.StartTime = &started
	crashing.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse, LastTransitionTime: flipped}}
	if got := statusSince(crashing, "degraded"); !got.Equal(flipped.Time) {
		t.Errorf("crash-looping pod: since %v, want when it stopped being ready (%v)", got, flipped.Time)
	}

	noCondition := ownedPod("ReplicaSet", "api", corev1.PodRunning, created)
	noCondition.Status.StartTime = &started
	noCondition.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "api",
		LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{FinishedAt: crashed}}}}
	if got := statusSince(noCondition, "degraded"); !got.Equal(crashed.Time) {
		t.Errorf("without a Ready condition: since %v, want the last crash (%v)", got, crashed.Time)
	}

	running := ownedPod("ReplicaSet", "api", corev1.PodRunning, created)
	running.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastTransitionTime: flipped}}
	if got := statusSince(running, "running"); !got.Equal(flipped.Time) {
		t.Errorf("running pod: since %v, want when it became ready (%v)", got, flipped.Time)
	}

	pending := ownedPod("", "", corev1.PodPending, created)
	pending.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, LastTransitionTime: flipped}}
	if got := statusSince(pending, "unschedulable"); !got.Equal(flipped.Time) {
		t.Errorf("unschedulable pod: since %v, want %v", got, flipped.Time)
	}
}
