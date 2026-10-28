import { common, AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { keepAlive } from '../chat/KeepAlive';

const TAG = 'HHTunnel';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, TAG, 'EntryAbility onCreate');
    this.handleDebugWant(want);
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.handleDebugWant(want);
  }

  private handleDebugWant(want: Want): void {
    if (want.parameters?.hhDebugDropUdp === true) {
      hilog.warn(0x0000, TAG, '收到 DEBUG UDP 故障注入 Want');
      this.context.eventHub.emit('harnessDebugDropUdp');
    }
    if (want.parameters?.hhDebugNatFilter === true) {
      hilog.info(0x0000, TAG, '收到 DEBUG NAT 过滤诊断 Want');
      this.context.eventHub.emit('harnessDebugNatFilter');
    }
  }

  /**
   * 接管系统返回（右/左边缘滑动返回、导航栏返回键）：
   * 先同步通知界面，界面在子页面（聊天/设置等）消费返回则留驻 App，否则按系统默认退出。
   */
  onBackPressed(): boolean {
    AppStorage.setOrCreate('hh_back_consumed', false);
    this.context.eventHub.emit('harnessBack');
    const consumed: boolean = AppStorage.get<boolean>('hh_back_consumed') ?? false;
    AppStorage.setOrCreate('hh_back_consumed', false);
    return consumed;
  }

  /** 退后台/锁屏：申请 DATA_TRANSFER 长时任务，保住 WS 流与轮询连接 */
  onBackground(): void {
    hilog.info(0x0000, TAG, 'onBackground → keepAlive.start');
    keepAlive.start(this.context);
  }

  /** 回前台：释放长时任务 */
  onForeground(): void {
    hilog.info(0x0000, TAG, 'onForeground → keepAlive.stop');
    keepAlive.stop(this.context);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(0x0000, TAG, 'loadContent succeeded');
    });
  }
}
