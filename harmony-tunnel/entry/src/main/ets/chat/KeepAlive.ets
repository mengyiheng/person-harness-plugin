import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'HHKeepAlive';

/**
 * 长时任务保活（v2.0 任务1）：
 * 退后台/锁屏期间申请 DATA_TRANSFER 长时任务，防止系统挂起 App 导致
 * WS follow 流与 session 轮询中断；回前台即释放，不常驻耗电。
 */
class KeepAlive {
  private running: boolean = false;

  async start(ctx: common.UIAbilityContext): Promise<void> {
    if (this.running) {
      return;
    }
    try {
      const wa: WantAgent = await wantAgent.getWantAgent({
        wants: [{ bundleName: 'com.happyharness.tunnel', abilityName: 'EntryAbility' }],
        operationType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      } as wantAgent.WantAgentInfo);
      await backgroundTaskManager.startBackgroundRunning(
        ctx, backgroundTaskManager.BackgroundMode.DATA_TRANSFER, wa);
      this.running = true;
      hilog.info(0x0000, TAG, 'background task started (DATA_TRANSFER)');
    } catch (e) {
      const err = e as Error;
      hilog.error(0x0000, TAG, 'startBackgroundRunning failed: %{public}s code=%{public}d',
        err.message, (e as BusinessError).code ?? -1);
    }
  }

  async stop(ctx: common.UIAbilityContext): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(ctx);
      this.running = false;
      hilog.info(0x0000, TAG, 'background task stopped');
    } catch (e) {
      const err = e as Error;
      hilog.error(0x0000, TAG, 'stopBackgroundRunning failed: %{public}s', err.message);
    }
  }
}

export const keepAlive = new KeepAlive();
