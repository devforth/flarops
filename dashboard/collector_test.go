package main

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func node(ready bool, unschedulable bool, taints ...corev1.Taint) *corev1.Node {
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	return &corev1.Node{
		Spec:   corev1.NodeSpec{Unschedulable: unschedulable, Taints: taints},
		Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: status}}},
	}
}

func TestSchedulableForCapsules(t *testing.T) {
	capsule := corev1.Taint{Key: CapsuleTaint, Value: "true", Effect: corev1.TaintEffectNoSchedule}
	other := corev1.Taint{Key: "node.kubernetes.io/disk-pressure", Effect: corev1.TaintEffectNoSchedule}
	cases := []struct {
		name string
		n    *corev1.Node
		want bool
	}{
		{"ready server", node(true, false), true},
		{"worker with the capsule taint", node(true, false, capsule), true},
		{"worker with the capsule taint and another NoSchedule taint", node(true, false, capsule, other), false},
		{"another NoSchedule taint", node(true, false, other), false},
		{"cordoned", node(true, true), false},
		{"not ready", node(false, false, capsule), false},
	}
	for _, c := range cases {
		if got := schedulableForCapsules(c.n); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
