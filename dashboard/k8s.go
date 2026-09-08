package main

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	corelisters "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metrics "k8s.io/metrics/pkg/client/clientset/versioned"
)

type K8sClient struct {
	clientset       *kubernetes.Clientset
	metrics         *metrics.Clientset
	informerFactory informers.SharedInformerFactory
	nodeLister      corelisters.NodeLister
	podLister       corelisters.PodLister
	configMapLister corelisters.ConfigMapLister
}

func NewK8sClient() (*K8sClient, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		log.Println("Not running in cluster, falling back to kubeconfig")
		var kubeconfig string
		if home := homedir.HomeDir(); home != "" {
			kubeconfig = filepath.Join(home, ".kube", "config")
		}
		config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, err
		}
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, err
	}

	metricsClient, err := metrics.NewForConfig(config)
	if err != nil {
		return nil, err
	}

	factory := informers.NewSharedInformerFactory(clientset, 10*time.Minute)
	nodeInformer := factory.Core().V1().Nodes()
	podInformer := factory.Core().V1().Pods()
	cmInformer := factory.Core().V1().ConfigMaps()

	stopCh := make(chan struct{})
	factory.Start(stopCh)
	syncs := factory.WaitForCacheSync(stopCh)
	for informerType, synced := range syncs {
		if !synced {
			return nil, fmt.Errorf("failed to sync informer: %v", informerType)
		}
	}

	return &K8sClient{
		clientset:       clientset,
		metrics:         metricsClient,
		informerFactory: factory,
		nodeLister:      nodeInformer.Lister(),
		podLister:       podInformer.Lister(),
		configMapLister: cmInformer.Lister(),
	}, nil
}

func (k *K8sClient) GetNodes() ([]*corev1.Node, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := k.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var res []*corev1.Node
	for i := range list.Items {
		res = append(res, &list.Items[i])
	}
	return res, nil
}

func (k *K8sClient) GetPods() ([]*corev1.Pod, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := k.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var res []*corev1.Pod
	for i := range list.Items {
		res = append(res, &list.Items[i])
	}
	return res, nil
}

func (k *K8sClient) GetNodeMetrics() ([]metricsv1beta1.NodeMetrics, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	metrics, err := k.metrics.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	return metrics.Items, nil
}

func (k *K8sClient) GetPodMetrics() ([]metricsv1beta1.PodMetrics, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	metrics, err := k.metrics.MetricsV1beta1().PodMetricses("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	return metrics.Items, nil
}

func (k *K8sClient) GetConfigMaps(namespace string) ([]*corev1.ConfigMap, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := k.clientset.CoreV1().ConfigMaps(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var res []*corev1.ConfigMap
	for i := range list.Items {
		res = append(res, &list.Items[i])
	}
	return res, nil
}

func (k *K8sClient) GetPVCs() ([]*corev1.PersistentVolumeClaim, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := k.clientset.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var res []*corev1.PersistentVolumeClaim
	for i := range list.Items {
		res = append(res, &list.Items[i])
	}
	return res, nil
}

func (k *K8sClient) GetNodeStatsSummary(nodeName string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return k.clientset.CoreV1().RESTClient().Get().
		Resource("nodes").Name(nodeName).SubResource("proxy").Suffix("stats/summary").
		DoRaw(ctx)
}
