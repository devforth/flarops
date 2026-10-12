package main

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestPodCondition(t *testing.T) {
	old := metav1.NewTime(time.Now().Add(-time.Hour))
	fresh := metav1.NewTime(time.Now())
	waiting := func(reason string, restarts int32) corev1.ContainerStatus {
		return corev1.ContainerStatus{Name: "api", RestartCount: restarts,
			State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}
	}
	cases := []struct {
		name string
		pod  corev1.Pod
		kind string
	}{
		{"finished job", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodSucceeded}}, "done"},
		{"failed job", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodFailed}}, "degraded"},
		{"crash loop reads as failing, not running", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, StartTime: &old,
			ContainerStatuses: []corev1.ContainerStatus{waiting("CrashLoopBackOff", 7)}}}, "degraded"},
		{"image pull failure while pending", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending,
			ContainerStatuses: []corev1.ContainerStatus{waiting("ImagePullBackOff", 0)}}}, "degraded"},
		{"unschedulable", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending, Conditions: []corev1.PodCondition{{
			Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: corev1.PodReasonUnschedulable, Message: "0/2 nodes are available"}}}}, "unschedulable"},
		{"pulling an image during a deploy is not a queue", corev1.Pod{Spec: corev1.PodSpec{NodeName: "srv"}, Status: corev1.PodStatus{Phase: corev1.PodPending,
			ContainerStatuses: []corev1.ContainerStatus{waiting("ContainerCreating", 0)}}}, "deploying"},
		{"starting, not ready yet", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, StartTime: &fresh,
			ContainerStatuses: []corev1.ContainerStatus{{Name: "api", Ready: false}}}}, "deploying"},
		{"never became ready", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, StartTime: &old,
			ContainerStatuses: []corev1.ContainerStatus{{Name: "api", Ready: false}}}}, "degraded"},
		{"restarting between back-offs reads as failing", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, StartTime: &fresh,
			ContainerStatuses: []corev1.ContainerStatus{{Name: "api", Ready: false, RestartCount: 4,
				State:                corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
				LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Reason: "Error"}}}}}}, "degraded"},
		{"running", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning, StartTime: &old,
			ContainerStatuses: []corev1.ContainerStatus{{Name: "api", Ready: true}}}}, "running"},
	}
	for _, c := range cases {
		if kind, reason, _ := podCondition(&c.pod); kind != c.kind {
			t.Errorf("%s: got %q (%s), want %q", c.name, kind, reason, c.kind)
		}
	}
}

func TestNodeRole(t *testing.T) {
	for name, want := range map[string]string{"shop-worker-1": "worker", "shop-worker-12": "worker", "ip-10-0-1-5": "server", "worker-x": "server"} {
		if got := nodeRole(name); got != want {
			t.Errorf("nodeRole(%q) = %q, want %q", name, got, want)
		}
	}
}
