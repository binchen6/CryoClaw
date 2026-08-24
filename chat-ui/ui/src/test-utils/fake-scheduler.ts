/**
 * 测试共享假调度器：手动推进回调的核心逻辑
 * （chat.test.ts 的 rAF 变体与 gateway.test.ts 的 timer 变体共用）。
 */
export class FakeScheduler<F extends (...args: any[]) => void> {
  protected nextId = 1;
  protected tasks = new Map<number, { id: number; fn: F }>();
  private readonly invoke: (fn: F) => void;

  constructor(invoke: (fn: F) => void) {
    this.invoke = invoke;
  }

  schedule(fn: F): number {
    const id = this.nextId++;
    this.tasks.set(id, { id, fn });
    return id;
  }

  cancel(id: number): void {
    this.tasks.delete(id);
  }

  // 单步推进一个任务，便于把握回调触发的先后顺序。
  runNext(): void {
    const task = [...this.tasks.values()].sort((a, b) => a.id - b.id)[0];
    if (!task) {
      return;
    }
    this.tasks.delete(task.id);
    this.invoke(task.fn);
  }

  // 顺序执行当前所有待触发回调，模拟时间推进。
  runAll(): void {
    while (this.tasks.size > 0) {
      this.runNext();
    }
  }
}
