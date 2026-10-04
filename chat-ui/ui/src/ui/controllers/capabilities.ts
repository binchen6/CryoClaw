/**
 * 内核能力门控（T1/T7）：hello-ok 握手携带 features.methods / features.events
 * （gateway.ts GatewayHelloOk），据此判断当前内核是否注册了某 RPC 方法或广播事件。
 * 内核升级移除接口时（如 2026.9.7 移除 tasks.*），调用点应门控降级而非裸报错；
 * 见 docs/kernel-recon/rpc-baseline.json 的 gap 登记。
 */
import type { GatewayHelloOk } from "../gateway.ts";

export type GatewayCapabilities = {
  /** null = 内核未声明能力面（旧内核），调用方保守放行 */
  methods: ReadonlySet<string> | null;
  events: ReadonlySet<string> | null;
};

const UNKNOWN: GatewayCapabilities = { methods: null, events: null };
const cache = new WeakMap<object, GatewayCapabilities>();

export function capabilitiesOf(hello: GatewayHelloOk | null | undefined): GatewayCapabilities {
  if (!hello) {
    return UNKNOWN;
  }
  const hit = cache.get(hello);
  if (hit) {
    return hit;
  }
  const methods = hello.features?.methods;
  const events = hello.features?.events;
  const caps: GatewayCapabilities = {
    methods: Array.isArray(methods) ? new Set(methods) : null,
    events: Array.isArray(events) ? new Set(events) : null,
  };
  cache.set(hello, caps);
  return caps;
}

export function supportsMethod(hello: GatewayHelloOk | null | undefined, name: string): boolean {
  const methods = capabilitiesOf(hello).methods;
  return methods === null ? true : methods.has(name);
}

export function supportsEvent(hello: GatewayHelloOk | null | undefined, name: string): boolean {
  const events = capabilitiesOf(hello).events;
  return events === null ? true : events.has(name);
}
