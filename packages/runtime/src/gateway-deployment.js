import { ControlPlaneGateway } from './gateway.js';
import { RuntimeLifecycleManager } from './lifecycle.js';
import { RuntimeShutdownAdmission } from './shutdown-admission.js';
import { RuntimeShutdownCoordinator } from './shutdown-coordinator.js';
import { RuntimeSupervisorKernel } from './supervisor.js';
import { RuntimeFailoverKernel } from './failover.js';
import { RuntimeDeploymentHost } from './deployment-host.js';

// Concrete local HTTP service composition. The deployment must provide a
// stable incident identity and an effect-fenced recovery callback.
export class RuntimeGatewayDeployment {
  constructor({ controlPlane, store, incidentId, recover, owner, host = '127.0.0.1', port = 0, authorize, intervalMs = 1000, processRef } = {}) {
    if (!controlPlane || typeof controlPlane.getHealth !== 'function') throw new TypeError('controlPlane with getHealth() is required');
    if (typeof incidentId !== 'function' || typeof recover !== 'function') throw new TypeError('incidentId and recover callbacks are required');
    if (host !== '127.0.0.1' && typeof authorize !== 'function') throw new TypeError('non-loopback gateway requires authorize()');
    this.admission = new RuntimeShutdownAdmission();
    this.gateway = new ControlPlaneGateway({ controlPlane, authorize, shutdownAdmission: this.admission });
    this.lifecycle = new RuntimeLifecycleManager({ components: [{ name: 'gateway', start: () => this.gateway.listen({ host, port }), stop: () => this.gateway.close() }] });
    this.coordinator = new RuntimeShutdownCoordinator({ lifecycle: this.lifecycle, admission: this.admission });
    this.supervisor = new RuntimeSupervisorKernel({ components: { gateway: { check: () => {
      if (!this.gateway.server?.listening) return { state: 'failed' };
      const status = controlPlane.getHealth().status;
      return { state: status === 'healthy' ? 'healthy' : status === 'degraded' ? 'degraded' : status === 'critical' || status === 'failed' ? 'failed' : 'unavailable' };
    } } } });
    this.failover = new RuntimeFailoverKernel({ supervisor: this.supervisor, store, recover, owner });
    this.host = new RuntimeDeploymentHost({ coordinator: this.coordinator, failover: this.failover, name: 'gateway', incidentId, intervalMs, processRef });
  }

  async start() { await this.host.start(); return this.gateway.server.address(); }
  shutdown(options) { return this.host.shutdown(options); }
}
