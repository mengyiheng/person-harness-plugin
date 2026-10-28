/**
 * Person Harness 主界面（v4 协议实测版）。
 * 架构：单 WebSocket 复用（协议事实：WS 断开 → Cookie 失效），断线用存的 launch token 自动重铸 Cookie。
 * 布局对齐 DeepSeek Harness 桌面版：侧边栏式会话列表 + 主聊天区。
 */
import { common } from '@kit.AbilityKit';
import { scanBarcode } from '@kit.ScanKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { SecureStore } from '../chat/SecureStore';
import {
  PairCodeV2, DeviceMetaV2, PairSummary,
} from '../chat/Types';
import { RelayClient } from '../chat/RelayClient';
import { RelayHarnessClient, RelayFollow, loadOrCreateIdentity } from '../chat/V2Transport';
import { parsePairCodeV2, registerDevice, redeemCode, fetchPairs, wsUrlOf, httpUrlOf } from '../chat/PairV2';
import { LocalProxy } from '../chat/LocalProxy';
import { webview } from '@kit.ArkWeb';
import { image as imageKit } from '@kit.ImageKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { pasteboard } from '@kit.BasicServicesKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { promptAction, window } from '@kit.ArkUI';

const TAG: string = 'HHIndex';
const DEFAULT_SERVER: string = '8.137.177.62:9400'; // 手动配对码无 server 信息时的默认协调服务器
const ERR_TIMEOUT: string = 'ERR_TIMEOUT'; // 错误码前缀（超时判定用；v1 客户端文件已移除）
const EMPTY_ARGS: Record<string, Object> = {};
const PRIMARY: string = '#4D6BFE';      // DeepSeek 品牌蓝
const CARD: string = '#F7F8FA';
const SUB: string = '#6B6F80';          // 次要文字
const DANGER: string = '#D93026';

/** 工具页：电脑文件列表项（/__ph/files/list 的 items 元素） */
interface ToolFileItem {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  path?: string;   // 快捷项/盘符项的完整路径（普通项 = toolPath + name 现算）
  quick?: boolean; // 快捷目录项（起始页）
}

/** 多选传送的选中项 */
interface SelItem {
  path: string;
  name: string;
  dir: boolean;
  size: number;
}

/** files/tree 的文件元素（批量取回清单） */
interface TreeFile {
  path: string;
  rel: string;
  size: number;
}

/** 工具页：窗口实况的可选窗口（/__ph/windows/list 的 windows 元素） */
interface LiveWindowItem {
  hwnd: string;
  title: string;
  w: number;
  h: number;
  minimized: boolean;
}

/** 资料检索页：/__ph/data/search 的 results 元素（字段可能随版本增加，取值全部容错） */
interface DataSearchItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
  hits: Array<string>;
}

/** 资料检索页：/__ph/data/sources 的 sources 元素 */
interface DataSourceItem {
  path: string;
  files: number;
  lastScan: string;
}

@Entry
@Component
struct Index {
  @State view: string = 'pair'; // pair | web | wait | devices | rlpick | tools*
  // v2.1 WebView 完整模式（App 唯一主形态）：本地代理 + dsh 完整 GUI
  @State webUrl: string = '';
  @State webLoading: boolean = false;
  private webCtrl: webview.WebviewController = new webview.WebviewController();
  private localProxy?: LocalProxy;
  private webIntent: boolean = false; // v2 设备的目标形态（activateV2 即置位，供 onReady 判断）
  // v2.1 悬浮状态条：直连 / 中转 双灯 + 工具按钮（2026-10-26：协调/中继 改为 直连/中转）
  @State coordOk: boolean = false;
  @State relayOk: boolean = false;
  @State directOk: boolean = false;      // 直连灯：仅 UDP 可靠业务通道真实建立时开启
  @State directLatencyMs: number = -1;    // UDP SYN→ACK 实测 RTT；未直连/已回落显示 --，不借用中转延迟
  @State overlayOpen: boolean = true;
  private relayDownSince: number = 0; // 🔴 断链计时：relayOk 由 true→false 时刻（0=未断）
  private statusTimer: number = -1;
  @State pairStatus: string = '';
  @State pairing: boolean = false;
  @State manualCode: string = ''; // v2.1 手动配对码输入

  @State pairedHost: string = '';
  @State pairedPort: number = 0;
  @State listStatus: string = '';
  @State latencyMs: number = -1;         // 最近 3 次 ping 的中位数：-1 测速中，-2 连续失败
  @State latencyErr: string = '';        // ping 失败原因：'timeout' 或 'error'（区分超时与其他故障）
  @State connLost: boolean = false;      // 网络层断开（非授权过期）
  private latencySamples: number[] = [];
  private latencyFailures: number = 0;

  private store?: SecureStore;
  private client?: RelayHarnessClient; // v2：经中继的 RPC 适配（activateV2 赋值，startLatencyLoop 消费）
  private relay?: RelayClient;      // v2：中继连接（存在即表示当前设备走 v2）
  private v2meta?: DeviceMetaV2;    // v2：当前 PC 设备元信息
  private remintCount: number = 0;       // 连续自动重铸次数上限
  private latencyTimer: number = -1;
  private reconnectTimer: number = -1;
  private v2follow?: RelayFollow;        // v2：follow 适配器（重连重建用）
  @State v2devices: Array<DeviceMetaV2> = []; // v2：已配对 PC 列表（设备页展示/切换用）
  @State rlCandidates: Array<DeviceMetaV2> = []; // V4.2：网页扫码授权的候选电脑（本机配对 ∩ 二维码服务器）
  @State rlPendingId: string = '';
  @State rlPendingPath: string = '/__ph/remote-login/approve';
  private scroller: Scroller = new Scroller();  // 聊天消息区滚动控制

  // ---- 工具页（文件互传 / 剪贴板 / 截图）：经 relay.httpCall 与 PC 插件通信 ----
  @State toolFiles: Array<ToolFileItem> = [];  // 当前目录列表
  @State toolPath: string = '';                // 当前浏览的电脑目录（'' = 用户主目录）
  @State fileSearchMode: boolean = false;      // 文件互传内嵌检索模式（2026-10-25：检索嵌入互传）
  @State dataReadBack: string = 'toolsData';   // 内容查看页的返回目标（toolsData=独立检索页 / toolsFiles=互传内嵌）
  @State selMode: boolean = false;             // 多选模式（2026-10-25：多选/整夹传送）
  @State selItems: Array<SelItem> = [];        // 已选项（重新赋值触发渲染）
  @State mkdirVisible: boolean = false;        // 新建文件夹输入浮层（2026-10-25）
  @State mkdirName: string = '';
  // 分层预览（2026-10-25）：kind='' 纯文本（旧路径）| 'html'（md/代码/Office转换）| 'image'
  @State previewKind: string = '';
  @State previewHtml: string = '';
  @State previewPixel: imageKit.PixelMap | undefined = undefined;
  private previewCtrl: webview.WebviewController = new webview.WebviewController();
  @State toolStatus: string = '';              // 工具页状态/错误提示
  @State toolBusy: boolean = false;            // 请求进行中（防重复点击）
  @State clipText: string = '';                // 从电脑取回的剪贴板内容
  @State shotPreview: string = '';             // 截图预览（data:image/png;base64,...）
  @State shotPath: string = '';                // 截图沙箱落盘路径（保存到下载用）
  // ---- 单文件下载：进度行（显示在文件项文件名下方）+ 断点续传 ----
  @State dlItemPath: string = '';              // 当前下载项的完整源路径（'' = 无）
  @State dlText: string = '';                  // 进度文案（下载中 / 中断可续传提示）
  @State dlResume: boolean = false;            // 中断可续传（点击同一项触发续传）
  private dlName: string = '';                 // 续传元数据：文件名
  private dlTotal: number = 0;                 // 续传元数据：总字节数
  private dlTarget: string = '';               // 续传元数据：本地目标（picker uri 或沙箱路径）
  // ---- 批量下载断点续传（2026-10-26）----
  @State batchLeft: number = 0;                // 中断后剩余文件数（>0 显示续传条）
  private batchFiles: Array<TreeFile> = [];    // 批量任务清单（持久化恢复）
  private batchIndex: number = 0;              // 下一个待取文件下标（之前的已完成）
  @State toolNavRoot: boolean = false;         // 当前在盘符根/盘符列表（‹ 返回工具列表而非上级）
  @State liveScale: number = 1;                // 实况画面缩放（双指捏合）
  @State liveTx: number = 0;                   // 实况画面拖动偏移 X
  @State liveTy: number = 0;                   // 实况画面拖动偏移 Y
  @State liveFullscreen: boolean = false;       // 实况全屏（2026-10-27：隐藏状态行+系统栏，画面铺满）
  private livePinchStart: number = 1;          // 捏合手势起始缩放
  private b64Helper: util.Base64Helper = new util.Base64Helper(); // 工具页 base64 编解码

  // ---- 工具页：窗口实况（M4.5a 实况轮询 + M4.5b 点击回传）----
  @State liveWindows: Array<LiveWindowItem> = []; // 可选窗口列表
  @State liveHwnd: string = '';                // 当前选中窗口句柄（'' = 未选中）
  @State liveTitle: string = '';               // 当前选中窗口标题（点击回传用）
  @State liveFrame: string = '';               // 最近一帧（data:image/jpeg;base64,...）
  @State liveFrames: number = 0;               // 已收到的帧数
  @State liveW: number = 0;                    // 最近一帧宽度（px）
  @State liveH: number = 0;                    // 最近一帧高度（px）
  @State liveRunning: boolean = false;         // 轮询中
  private liveTimer: number = -1;              // 实况轮询定时器
  private liveBusy: boolean = false;           // 上一帧请求未返回时不叠加请求
  // （实况点击坐标归一化已改由 ClickEvent.target.area 直接换算，无需缓存组件尺寸）

  // ---- 资料检索页（/__ph/data/search|read|sources）----
  @State dsQuery: string = '';                    // 搜索关键词输入
  @State dsResults: Array<DataSearchItem> = [];   // 搜索结果
  @State dsIndexed: number = -1;                  // 已索引文件数（-1 = 未知/获取失败）
  @State dsReadPath: string = '';                 // 正在查看的文件路径（'' = 未打开）
  @State dsReadContent: string = '';              // 查看的文件内容（≤64KB）

  private debugDropUdpHandler: () => void = (): void => {
    this.relay?.debugDropUdpTraffic();
  };

  private debugNatFilterHandler: () => void = (): void => {
    this.relay?.debugNatFilter();
  };

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    this.store = new SecureStore(ctx);
    ctx.eventHub.on('harnessBack', this.backHandler);
    ctx.eventHub.on('harnessDebugDropUdp', this.debugDropUdpHandler);
    ctx.eventHub.on('harnessDebugNatFilter', this.debugNatFilterHandler);
    this.dlLoadJob();
    this.initFlow();
  }

  aboutToDisappear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    ctx.eventHub.off('harnessBack', this.backHandler);
    ctx.eventHub.off('harnessDebugDropUdp', this.debugDropUdpHandler);
    ctx.eventHub.off('harnessDebugNatFilter', this.debugNatFilterHandler);
    this.relay?.stop();
    this.relay = undefined;
    this.stopLatencyLoop();
    this.stopReconnectLoop();
  }

  /** 系统返回手势/导航栏返回：页面级 onBackPress，全面屏滑动与返回键都走这里。
   *  子页面消费返回留驻 App；列表/配对页返回 false 交回系统（退出 App）。 */
  onBackPress(): boolean {
    if (this.view === 'devices') {
      // v2.1：完整模式下子页面返回 —— 有 WebView 回 WebView，否则回等待页（无原生形态）
      this.view = this.webIntent && this.webUrl !== '' ? 'web' : 'wait';
      return true;
    }
    if (this.view === 'tools' || this.view === 'toolsFiles' || this.view === 'toolsClip' || this.view === 'toolsShot') {
      // 系统返回 = 直接退出工具子页回上一级界面（标准 UX；逐级回目录由页内 ‹ 按钮负责）
      this.view = this.webIntent && this.webUrl !== '' ? 'web' : 'wait';
      return true;
    }
    if (this.view === 'toolsDataRead') {
      // 资料检索：查看内容页返回来源页（独立检索页 / 文件互传内嵌检索）
      this.dsReadPath = '';
      this.dsReadContent = '';
      this.view = this.dataReadBack;
      return true;
    }
    if (this.view === 'toolsData') {
      this.view = this.webIntent && this.webUrl !== '' ? 'web' : 'wait';
      return true;
    }
    if (this.view === 'toolsLive') {
      // 全屏中：先退全屏；否则离开即停止轮询，再按工具页规则返回
      if (this.liveFullscreen) {
        this.toggleLiveFullscreen(false);
        return true;
      }
      this.stopLiveLoop();
      this.view = 'tools';
      return true;
    }
    if (this.view === 'pair' && this.webIntent && this.webUrl !== '') {
      // 完整模式下调出配对页后返回 → 回 WebView
      this.view = 'web';
      return true;
    }
    return false;
  }

  /** 保留 eventHub 通道（兼容 EntryAbility.onBackPressed 的调用路径） */
  private backHandler: () => void = (): void => {
    this.onBackPress();
  }

  // ---------------- 连接质量 ----------------

  private stopLatencyLoop(): void {
    if (this.latencyTimer >= 0) {
      clearTimeout(this.latencyTimer);
      this.latencyTimer = -1;
    }
  }

  /** 每 10s 做一次轻量 ping，最近 3 次取中位数，避免单次网络抖动把灯染橙/红 30s。
   *  失败时 3s 后复测；链路仍就绪情况下的单次失败保留上次颜色，连续失败才判异常。 */
  private startLatencyLoop(): void {
    this.stopLatencyLoop();
    this.latencySamples = [];
    this.latencyFailures = 0;
    this.latencyMs = -1;
    this.latencyErr = '';
    const tick = (): void => {
      if (!this.client) {
        return;
      }
      let retryMs: number = 10000;
      this.client.ping().then((ms: number) => {
        hilog.info(0x0000, TAG, 'transport-ping 成功: %{public}dms', ms);
        this.latencySamples.push(ms);
        if (this.latencySamples.length > 3) {
          this.latencySamples.shift();
        }
        const sorted: number[] = this.latencySamples.slice().sort((a: number, b: number) => a - b);
        this.latencyMs = sorted[Math.floor(sorted.length / 2)];
        this.latencyFailures = 0;
        this.latencyErr = '';
        this.connLost = false;
        this.remintCount = 0;
      }).catch((e: Object) => {
        const msg: string = String((e as Error).message ?? e);
        hilog.warn(0x0000, TAG, 'transport-ping 失败: %{public}s', msg);
        retryMs = 3000;
        const relayReady: boolean = this.relay !== undefined && this.relay.isReady();
        if (relayReady) {
          this.latencyFailures++;
        }
        this.latencyErr = msg.indexOf(ERR_TIMEOUT) === 0 ? 'timeout' : 'error';
        if (this.latencyFailures >= 2) {
          this.latencyMs = -2;
          // 🔴 假死链自愈（2026-10-27 补）：手机网络闪断后 ArkWS 可能不回调 close，
          //    TCP 半开→请求进黑洞且永不重连。连续 2 次失败即主动重连（stop 是终态，必须紧跟 start）。
          const r = this.relay;
          if (r) {
            hilog.warn(0x0000, TAG, '连续 %{public}d 次 ping 失败，判定假死链，主动重连', this.latencyFailures);
            this.latencyFailures = 0;
            try { r.stop(); } catch (err) { /* 忽略 */ }
            setTimeout(() => {
              try { r.start(); } catch (err2) { hilog.warn(0x0000, TAG, '假死链重连失败: %{public}s', String(err2)); }
            }, 500);
          }
        }
        this.connLost = !relayReady;
      }).finally(() => {
        if (this.client) {
          this.latencyTimer = setTimeout(tick, retryMs);
        }
      });
    };
    tick();
  }

  private qualityText(): string {
    if (this.latencyMs === -2) {
      // 区分：HTTP 真超时 vs 其他故障（HTTP 200 也曾显示"连接超时"，交接文档附录 bug#2）
      return this.latencyErr === 'timeout' ? '连接超时' : '连接异常';
    }
    if (this.latencyMs < 0) {
      return '测速中';
    }
    return `${this.latencyMs}ms`;
  }

  private qualityColor(): string {
    if (this.latencyMs === -2) {
      return DANGER;
    }
    if (this.latencyMs < 0) {
      return SUB;
    }
    if (this.latencyMs < 300) {
      return '#2E8B57';
    }
    if (this.latencyMs < 1000) {
      return PRIMARY;
    }
    if (this.latencyMs < 3000) {
      return '#E67E22';
    }
    return DANGER;
  }

  /** 未建立=灰；已建立按最近 3 次 ping 中位数：绿<1s / 橙 1~3s / 红>=3s 或连续失败。 */
  private pathLightColor(ok: boolean): string {
    if (!ok) {
      return '#8A8F9E'; // 灰：此路不通
    }
    if (this.latencyMs === -2) {
      return DANGER;
    }
    if (this.latencyMs < 1000) {
      return '#22C55E'; // 测速中或响应正常：绿色不代表带宽，只代表链路可用且响应快
    }
    if (this.latencyMs < 3000) {
      return '#E67E22';
    }
    return DANGER;
  }

  /** 双灯不再写“直连/中转”：上排显示直连延迟，下排显示中转延迟。 */
  private pathLatencyText(direct: boolean): string {
    const ms: number = direct ? this.directLatencyMs : this.latencyMs;
    if (ms === -2) {
      return '异常';
    }
    if (ms < 0) {
      return '--';
    }
    return ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
  }

  /** 去掉 ERR_XXX 前缀，给用户看干净文案 */
  private stripCode(msg: string): string {
    const idx: number = msg.indexOf(': ');
    if (idx > 0 && msg.substring(0, idx).indexOf('ERR_') === 0) {
      return msg.substring(idx + 2);
    }
    return msg;
  }

  // ---------------- 断线重连 ----------------

  private stopReconnectLoop(): void {
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
  }

  // ---------------- 配对 ----------------

  /** 启动：恢复 v2 设备，无可用设备进配对页 */
  private async initFlow(): Promise<void> {
    // v2 设备优先恢复
    try {
      const v2all: Array<DeviceMetaV2> = await this.store!.listV2Meta();
      const v2active: string = await this.store!.getV2Active();
      let v2: DeviceMetaV2 | undefined;
      v2all.forEach((m: DeviceMetaV2) => {
        if (m.id === v2active) {
          v2 = m;
        }
      });
      if (!v2 && v2all.length > 0) {
        v2 = v2all[0];
      }
      if (v2) {
        const m: DeviceMetaV2 = v2 as DeviceMetaV2;
        const credential: string = await this.store!.getV2Credential(m.id);
        if (credential) {
          await this.activateV2(m, credential);
          return;
        }
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, 'v2 恢复失败: %{public}s', String(e));
    }
    this.view = 'pair';
  }

  /** 打开设备页（刷新 v1+v2 列表；v2 顺带从云端拉最新 PC 显示名） */
  private async openDevices(): Promise<void> {
    try {
      this.v2devices = await this.store!.listV2Meta();
    } catch (e) {
      this.v2devices = [];
    }
    // 显示名刷新：PC 端改名/升级版本后云端是最新的（本地存量名可能是老的 "dsh-plugin"）
    const refreshTasks: Array<Promise<void>> = [];
    this.v2devices.forEach((m: DeviceMetaV2) => {
      const task = (async (): Promise<void> => {
        try {
          const credential: string = await this.store!.getV2Credential(m.id);
          if (!credential) {
            return;
          }
          const items: Array<PairSummary> = await fetchPairs(m.server, credential);
          for (let i: number = 0; i < items.length; i++) {
            if (items[i].pc.deviceId === m.pcDeviceId && items[i].pc.name && items[i].pc.name !== m.name) {
              m.name = items[i].pc.name;
              await this.store!.saveV2Meta(m);
            }
            // 设备编号：云端下发则记录（旧版服务端无此字段，容错保留原值）
            if (items[i].pc.deviceId === m.pcDeviceId && items[i].pc.seq !== undefined
              && items[i].pc.seq !== m.seq) {
              m.seq = String(items[i].pc.seq);
              await this.store!.saveV2Meta(m);
            }
          }
        } catch (e) {
          // 云端不可达时保留本地名
        }
      })();
      refreshTasks.push(task);
    });
    await Promise.all(refreshTasks);
    this.v2devices = this.v2devices.slice(); // 触发 UI 刷新
    this.view = 'devices';
  }

  /** v2 设备切换（断当前 relay，激活目标配对并进其会话） */
  private async switchV2Device(id: string): Promise<void> {
    let meta: DeviceMetaV2 | undefined;
    this.v2devices.forEach((m: DeviceMetaV2) => {
      if (m.id === id) {
        meta = m;
      }
    });
    if (!meta) {
      return;
    }
    const m: DeviceMetaV2 = meta as DeviceMetaV2;
    if (m.id === this.v2meta?.id && this.relay) {
      this.view = this.webUrl ? 'web' : 'wait';
      return;
    }
    const credential: string = await this.store!.getV2Credential(m.id);
    if (!credential) {
      this.reportStatus('该设备的凭证缺失，请删除后重新扫码配对');
      return;
    }
    await this.activateV2(m, credential);
  }

  /** v2 设备删除（清配对数据；删当前设备则切到剩余第一台） */
  private async removeV2Device(id: string): Promise<void> {
    await this.store!.removeV2(id);
    this.v2devices = await this.store!.listV2Meta();
    if (this.v2meta?.id === id) {
      this.teardownV1Connections();
      if (this.relay) {
        this.relay.stop();
        this.relay = undefined;
      }
      if (this.localProxy) {
        this.localProxy.stop();
        this.localProxy = undefined;
      }
      this.v2follow = undefined;
      this.v2meta = undefined;
      if (this.v2devices.length > 0) {
        await this.switchV2Device(this.v2devices[0].id);
      } else {
        this.view = 'pair';
      }
    }
  }

  /** v2.1 手动配对码：PC /ph pair 输出的 6 位码（云端自带 PC 绑定，走默认协调服务器） */
  private async manualPair(): Promise<void> {
    const code: PairCodeV2 = { server: DEFAULT_SERVER, device: '', code: this.manualCode };
    await this.pairV2Flow(code);
  }

  /** 扫码：v2 配对码 / myapp://remote-link|remote-login 远程链接二维码 */
  private async scanPair(): Promise<void> {
    if (this.pairing) {
      return;
    }
    try {
      const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(getContext(this));
      const raw: string = result.originalValue.trim();
      const v2code: PairCodeV2 | null = parsePairCodeV2(raw);
      if (v2code) {
        await this.pairV2Flow(v2code);
        return;
      }
      if (raw.indexOf('myapp://remote-link') === 0) {
        await this.remoteLinkFlow(raw, 'myapp://remote-link', '/__ph/remote-link/approve');
        return;
      }
      if (raw.indexOf('myapp://remote-login') === 0) {
        await this.remoteLinkFlow(raw, 'myapp://remote-login', '/__ph/remote-login/approve');
        return;
      }
      this.reportStatus('仅支持 v2 配对码或远程链接二维码');
    } catch (e) {
      hilog.warn(0x0000, TAG, '扫码取消或失败: %{public}s', String(e));
      this.reportStatus('扫码取消或失败，请重试');
    }
  }

  private reportStatus(msg: string): void {
    if (!this.pairedHost) {
      this.pairStatus = msg;
    } else {
      this.listStatus = msg;
    }
  }

  // ---------------- v2 配对与中继 ----------------


  /** V4 远程登录授权：扫 myapp://remote-link|remote-login → 确认 → 经 E2E 通知目标 PC 批准 */
  private async remoteLinkFlow(raw: string, prefix: string, approvePath: string): Promise<void> {
    const params: Record<string, string> = {};
    raw.substring(prefix.length).replace(/^\?/, '').split('&').forEach((kv: string) => {
      const idx: number = kv.indexOf('=');
      if (idx > 0) {
        params[decodeURIComponent(kv.substring(0, idx))] = decodeURIComponent(kv.substring(idx + 1));
      }
    });
    const from: string = params['from'] ?? params['pc'] ?? '';
    const server: string = params['server'] ?? '';
    const linkId: string = params['id'] ?? '';
    const isLogin: boolean = approvePath.indexOf('remote-login') >= 0;
    if (!linkId || (isLogin ? !server : !from)) {
      this.reportStatus('远程登录二维码内容不完整');
      return;
    }
    // V4.2 按人显示：网页二维码不再指定电脑——由本机存的配对决定
    //   （服务器上配了哪些电脑，就只能连哪些；多台时弹选择器）
    const metas: Array<DeviceMetaV2> = await this.store!.listV2Meta();
    const candidates: Array<DeviceMetaV2> = [];
    if (isLogin) {
      metas.forEach((m: DeviceMetaV2) => {
        if (m.server === server && (!from || m.pcDeviceId === from)) {
          candidates.push(m);
        }
      });
      if (candidates.length === 0) {
        this.reportStatus('本机没有该服务器上的电脑配对（先配对那台电脑）');
        return;
      }
      if (candidates.length === 1) {
        await this.remoteLinkApprove(candidates[0], linkId, approvePath);
        return;
      }
      // 多台：进入选择页
      this.rlCandidates = candidates;
      this.rlPendingId = linkId;
      this.rlPendingPath = approvePath;
      this.view = 'rlpick';
      return;
    }
    // remote-link（PC-to-PC）：QR 带目标电脑号，精确匹配
    let meta: DeviceMetaV2 | undefined;
    metas.forEach((m: DeviceMetaV2) => {
      if (m.pcDeviceId === from) {
        meta = m;
      }
    });
    if (!meta) {
      this.reportStatus('未找到该电脑的配对（需先在本机配对过那台电脑）');
      return;
    }
    await this.remoteLinkApprove(meta as DeviceMetaV2, linkId, approvePath);
  }

  /** V4.2 网页扫码授权：多台配对时的电脑选择页 */
  @Builder
  rlPickView() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => {
          this.view = this.webIntent && this.webUrl !== '' ? 'web' : (this.webIntent ? 'wait' : 'list');
        })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Text('选择要登录的电脑').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
      }.width('100%')

      Text('网页请求远程登录，本机在该服务器上配对过多台电脑，请选择授权目标。')
        .fontSize(12).fontColor(SUB).alignSelf(ItemAlign.Start)

      List({ space: 8 }) {
        ForEach(this.rlCandidates, (m: DeviceMetaV2) => {
          ListItem() {
            Row({ space: 10 }) {
              Text(m.name)
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor('#1A1A1A')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)
              Text(m.server)
                .fontSize(11)
                .fontColor('#9AA0B0')
                .maxLines(1)
            }
            .width('100%')
            .padding(12)
            .backgroundColor(CARD)
            .borderRadius(12)
          }
          .onClick(() => {
            const target: DeviceMetaV2 = m;
            const id: string = this.rlPendingId;
            const path: string = this.rlPendingPath;
            // 🔴 批准完成前不切界面（2026-10-24 事故：先切走导致授权失败完全不可见），完成后由 toast+切页
            this.remoteLinkApprove(target, id, path).then(() => {
              if (this.view === 'rlpick') {
                this.view = this.webIntent && this.webUrl !== '' ? 'web' : (this.webIntent ? 'wait' : 'list');
              }
            });
          })
        }, (m: DeviceMetaV2) => m.id)
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  /** V4 远程登录授权执行：选择授权时长 → 连目标 PC → 经 E2E 发授权 */
  private async remoteLinkApprove(target: DeviceMetaV2, linkId: string, approvePath: string): Promise<void> {
    const isLogin: boolean = approvePath.indexOf('remote-login') >= 0;
    const kindText: string = isLogin ? '在网页上远程登录' : '远程登录';
    // 连到目标 PC（若当前不是它）——必须先连上，才能拉取目标列表
    if (this.v2meta?.id !== target.id || !this.relay || !this.relay.isReady()) {
      const credential: string = await this.store!.getV2Credential(target.id);
      if (!credential) {
        this.reportStatus('该电脑的凭证缺失，请删除设备后重新配对');
        return;
      }
      await this.activateV2(target, credential);
    }
    // 等中继就绪（activateV2 内部重连中）
    for (let i: number = 0; i < 30; i++) {
      if (this.relay && this.relay.isReady()) {
        break;
      }
      await new Promise<void>((r: () => void) => setTimeout(r, 500));
    }
    if (!this.relay || !this.relay.isReady()) {
      this.reportStatus('中继未就绪，远程登录授权失败（稍后重试）');
      return;
    }
    // 🔲 C 授权跟随目标（2026-10-26）：拉取该电脑的可选 agent 目标，授权时一并选择
    let agentTarget: string = 'dsh';
    try {
      const tr = await this.relay.httpCall('POST', '/__ph/targets', '{}');
      const parsedT = JSON.parse(tr.bodyText) as Record<string, Object>;
      const list = parsedT['targets'] as Array<Record<string, string>>;
      if (Array.isArray(list) && list.length > 1) {
        const names: string[] = [];
        const map: Record<string, string> = {};
        list.forEach((t: Record<string, string>) => {
          const label: string = t['label'] ?? t['name'] ?? 'dsh';
          names.push(label);
          map[label] = t['name'] ?? 'dsh';
        });
        const menu: promptAction.Button[] = names.slice(0, 6).map((n: string) => {
          return { text: n, color: '#1A1A1A' } as promptAction.Button;
        });
        const menuTuple = menu as [promptAction.Button, promptAction.Button?, promptAction.Button?, promptAction.Button?, promptAction.Button?, promptAction.Button?];
        const chosen: number = await new Promise<number>((resolve: (v: number) => void) => {
          promptAction.showActionMenu({
            title: '授权进入哪个界面？',
            buttons: menuTuple
          }).then((r: promptAction.ActionMenuSuccessResponse) => resolve(r.index))
            .catch(() => resolve(-1));
        });
        if (chosen < 0) {
          this.reportStatus('已拒绝远程登录授权');
          promptAction.showToast({ message: '已拒绝本次远程登录' });
          return;
        }
        agentTarget = map[names[chosen]] ?? 'dsh';
      }
    } catch (e) {
      // 旧插件无 /__ph/targets → 保持 dsh 直达（兼容）
    }
    const kindText2: string = agentTarget !== 'dsh' ? `（界面：${agentTarget}）` : '';
    // 授权时长选择：临时（浏览器本次使用）/ 长期（该浏览器 30 天） / 取消=拒绝
    const mode: string = await new Promise<string>((resolve: (v: string) => void) => {
      AlertDialog.show({
        title: '远程登录授权',
        message: `允许浏览器${kindText}「${target.name}」${kindText2}？\n\n临时授权：仅本次使用（约 2 小时内有效）\n长期授权：该浏览器 30 天内免扫码`,
        primaryButton: {
          value: '临时授权',
          action: (): void => resolve('temp')
        },
        secondaryButton: {
          value: '长期授权',
          action: (): void => resolve('long')
        },
        cancel: (): void => resolve('')
      });
    });
    if (mode === '') {
      this.reportStatus('已拒绝远程登录授权');
      promptAction.showToast({ message: '已拒绝本次远程登录' });
      if (this.view === 'rlpick') {
        this.view = this.webIntent && this.webUrl !== '' ? 'web' : (this.webIntent ? 'wait' : 'list');
      }
      return;
    }
    try {
      this.reportStatus('正在发送远程登录授权…');
      const body: string = JSON.stringify(isLogin
        ? { id: linkId, mode: mode, target: agentTarget }
        : { id: linkId, from: target.pcDeviceId, mode: mode, target: agentTarget });
      const res = await this.relay.httpCall('POST', approvePath, body);
      const text: string = res.bodyText;
      let msg: string = `授权失败（HTTP ${res.status}）`;
      let ok: boolean = false;
      try {
        const parsed = JSON.parse(text) as Record<string, Object>;
        if (parsed['ok'] === true) {
          ok = true;
          msg = '✅ 已授权，请在电脑网页上等待自动进入';
        } else {
          msg = '授权被拒：' + String(parsed['error'] ?? '未知原因');
        }
      } catch (e) {
        // 保持默认 msg
      }
      this.reportStatus(msg);
      // 🔴 结果必须 toast 醒目提示（2026-10-24 事故：失败只写状态行被用户完全忽略）
      promptAction.showToast({ message: ok ? '✅ 已授权，请在电脑网页查看' : msg, duration: ok ? 3000 : 5000 });
      hilog.info(0x0000, TAG, 'remote-link approve: HTTP %{public}d %{public}s', res.status, text.slice(0, 80));
    } catch (e) {
      this.reportStatus('授权请求失败: ' + (e as Error).message);
      promptAction.showToast({ message: '❌ 授权请求失败: ' + (e as Error).message, duration: 5000 });
    }
  }

  /** ver=2 扫码入口：注册本机身份 → 兑换配对码 → 连中继 */  private async pairV2Flow(code: PairCodeV2): Promise<void> {
    if (this.pairing) {
      return;
    }
    this.pairing = true;
    this.pairStatus = 'v2 配对中…';
    try {
      const identity = await loadOrCreateIdentity(this.store!);
      const existing: Array<DeviceMetaV2> = await this.store!.listV2Meta();
      // 🔴 匹配键 = server + pcDeviceId（2026-10-23 修复）：只按 server 匹配会把
      //    同一服务器上另一台电脑的配对顶替掉（多台 PC 各自配对互相覆盖）。
      //    二维码带 device 时精确匹配；手动输码（无 device）在兑换后按结果反查。
      let meta: DeviceMetaV2 | undefined;
      existing.forEach((m: DeviceMetaV2) => {
        if (code.device && m.server === code.server && m.pcDeviceId === code.device) {
          meta = m;
        }
      });
      let credential: string = '';
      if (!meta) {
        const reg = await registerDevice(code.server, 'harmony-phone', identity.publicKeyB64);
        const r = await redeemCode(code.server, code.code, reg.deviceId, identity.publicKeyB64);
        // 兑换结果反查（手动码路径）：已是本 PC 的旧配对 → 更新凭证，不新建条目
        let hit: DeviceMetaV2 | undefined;
        existing.forEach((m: DeviceMetaV2) => {
          if (m.server === code.server && m.pcDeviceId === r.pair.pc.deviceId) {
            hit = m;
          }
        });
        if (hit) {
          const m2: DeviceMetaV2 = hit as DeviceMetaV2;
          m2.name = (r.pair.pc.name && r.pair.pc.name.trim()) ? r.pair.pc.name.trim() : m2.name;
          await this.store!.saveV2Meta(m2);
          await this.store!.saveV2Credential(m2.id, r.deviceCredential);
          meta = m2;
          credential = r.deviceCredential;
        } else {
          const m: DeviceMetaV2 = {
            id: `v2_${util.generateRandomUUID()}`,
            name: (r.pair.pc.name && r.pair.pc.name.trim()) ? r.pair.pc.name.trim() : code.device,
            server: code.server,
            pcDeviceId: r.pair.pc.deviceId,
            deviceId: reg.deviceId,
          };
          meta = m;
          credential = r.deviceCredential;
          await this.store!.saveV2Meta(m);
          await this.store!.saveV2Credential(m.id, credential);
        }
      } else {
        const m2: DeviceMetaV2 = meta as DeviceMetaV2;
        // 🔴 扫码 = 用户明确要求重新配对（2026-10-23 踩坑）：旧凭证可能已在服务端被吊销
        //    （如 PC 端解除了配对），复用会永远 4001 重连循环。始终兑换新码并更新本地凭证；
        //    兑换失败（码过期/无效）才回退旧凭证尝试。
        try {
          const r = await redeemCode(code.server, code.code, m2.deviceId, identity.publicKeyB64);
          credential = r.deviceCredential;
          m2.pcDeviceId = r.pair.pc.deviceId;
          m2.name = (r.pair.pc.name && r.pair.pc.name.trim()) ? r.pair.pc.name.trim() : m2.name;
          await this.store!.saveV2Meta(m2);
          await this.store!.saveV2Credential(m2.id, credential);
        } catch (e) {
          hilog.warn(0x0000, TAG, '新码兑换失败，回退旧凭证: %{public}s', (e as Error).message);
          credential = await this.store!.getV2Credential(m2.id);
          if (!credential) {
            throw new Error('本地凭证缺失且新码兑换失败，请重新生成二维码');
          }
        }
      }
      await this.store!.setV2Active(meta.id);
      this.pairStatus = 'v2 配对成功，连接中继…';
      await this.activateV2(meta, credential);
      this.pairStatus = '';
      this.reportStatus('已通过 v2 中继连接');
    } catch (e) {
      const msg: string = (e as Error).message ?? String(e);
      hilog.error(0x0000, TAG, 'v2 配对失败: %{public}s', msg);
      this.pairStatus = `v2 配对失败：${this.stripCode(msg)}`;
    } finally {
      this.pairing = false;
    }
  }

  /** 停 v1 连接组件（切到 v2 或销毁时用） */
  private teardownV1Connections(): void {
    this.stopLatencyLoop();
    this.stopReconnectLoop();
    this.client = undefined;
  }

  /** 激活 v2 设备：建中继连接 + 传输适配，成功后进会话列表 */
  private async activateV2(meta: DeviceMetaV2, credential: string): Promise<void> {
    hilog.warn(0x0000, TAG, '⭐ activateV2 被调用: %{public}s（定位 12 秒自杀循环，2026-10-24）', meta.name);
    this.teardownV1Connections();
    if (this.relay) {
      this.relay.stop();
      this.relay = undefined;
    }
    // 🔴 连带停旧代理（2026-10-24 多设备切换掉线根因）：removeV2Device 早就对称地停了
    //    localProxy，activateV2 却只停 relay——旧代理若幸存，会绑着已 stop 的 relay（ready=false），
    //    与 onReady/startWeb 的并发重建互相踩，最终转发全部"中继未就绪"。
    if (this.localProxy) {
      this.localProxy.stop();
      this.localProxy = undefined;
    }
    this.webUrl = '';
    this.v2meta = meta;
    const identity = await loadOrCreateIdentity(this.store!);
    const relay = new RelayClient(wsUrlOf(meta.server, '/api/v1/tunnel'), credential, identity);
    this.relay = relay;
    const follow = new RelayFollow(relay);
    this.v2follow = follow;
    relay.onReset = (reason: string): void => {
      this.connLost = true;
      follow.onRelayReset();
      this.reportStatus(`${reason}，自动重连中…`);
    };
    relay.onReady = (): void => {
      this.connLost = false;
      follow.onRelayReady();
      // v2 无原生形态：断线重连成功后自动回 WebView 完整模式
      if (this.webIntent) {
        this.startWeb().catch((e: Object) => {
          hilog.warn(0x0000, TAG, 'onReady 重进 WebView 失败: %{public}s', String(e));
        });
      }
    };
    relay.onDirectChanged = (direct: boolean, latencyMs?: number): void => {
      if (this.relay !== relay) {
        return;
      }
      this.directOk = direct;
      this.directLatencyMs = direct ? (latencyMs ?? -1) : -1;
      hilog.info(0x0000, TAG, 'UDP 直连状态=%{public}d rtt=%{public}dms',
        direct ? 1 : 0, this.directLatencyMs);
    };
    this.client = new RelayHarnessClient(relay);
    this.pairedHost = meta.server;
    this.pairedPort = 0;
    this.webIntent = true; // v2 设备一律进完整模式
    this.view = 'wait'; // v2 不再有原生形态：连接期间显示等待页，成功即 WebView
    this.startLatencyLoop();
    try {
      await relay.start();
      this.stopReconnectLoop();
      // v2.1：连接成功即进 WebView 完整模式（不再前置 checkHealth——
      // session/list 响应 MB 级，经隧道可能超 15s 超时，把进入完整模式卡死在 catch 分支）
      await this.startWeb();
    } catch (e) {
      // 首连失败不放弃：relay 内部在指数退避重连，onReady 后自动恢复
      const msg: string = this.stripCode((e as Error).message ?? String(e));
      this.connLost = true;
      this.view = 'wait';
      this.reportStatus(`中继连接中：${msg}（自动重试）`);
    }
  }

  /** v2 等待/重连页：中继未就绪时的唯一形态（替代旧的原生列表回退） */
  @Builder
  waitView() {
    Column({ space: 16 }) {
      Blank().layoutWeight(1)
      Text('⏳')
        .fontSize(56)
      Text(this.v2meta?.name ?? '电脑')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .fontColor('#1A1A1A')
      Text(this.connLost || this.listStatus ? (this.listStatus || '正在连接中继…') : '正在连接中继…')
        .fontSize(14)
        .fontColor(SUB)
        .textAlign(TextAlign.Center)
        .padding({ left: 24, right: 24 })
      if (this.latencyErr) {
        Text(this.latencyErr).fontSize(12).fontColor('#C0392B')
      }
      Blank().layoutWeight(1)
      Button('重试连接')
        .width('60%')
        .height(44)
        .backgroundColor(PRIMARY)
        .fontColor('#FFFFFF')
        .borderRadius(22)
        .onClick(() => {
          const meta: DeviceMetaV2 | undefined = this.v2meta;
          if (!meta) {
            this.view = 'pair';
            return;
          }
          this.store!.getV2Credential(meta.id).then((c: string) => {
            if (c) {
              this.activateV2(meta, c);
            } else {
              this.view = 'pair';
            }
          });
        })
      Button('切换 Agent / 扫码')
        .width('60%')
        .height(44)
        .backgroundColor(CARD)
        .fontColor('#1A1A1A')
        .borderRadius(22)
        .onClick(() => { this.openDevices(); })
      Blank().layoutWeight(0.6)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F5F6F8')
  }

  /** v2.1 WebView 完整模式：拉起本地回环代理 → WebView 加载 dsh 完整 GUI。
   *  代理失败 → 停在等待页（v2 已无原生回退，2026-10-23 产品决策）。
   *  🔴 并发互斥（2026-10-24 多设备切换掉线根因之二）：onReady 与 activateV2 本体
   *  会并发各调一次 startWeb，两个重建互相 stop 对方刚建的代理 → 最终代理绑死旧 relay。
   *  in-flight 时直接返回，先到者负责重建。 */
  private webStarting: boolean = false;
  private async startWeb(): Promise<void> {
    if (this.webStarting) {
      return;
    }
    this.webStarting = true;
    try {
      if (!this.relay || !this.relay.isReady()) {
        throw new Error('中继未就绪');
      }
      if (!this.localProxy || !this.localProxy.ready || this.localProxy.relay !== this.relay) {
        // 代理未建/已停/绑的不是当前 relay（换代遗留）→ 一律重建
        if (this.localProxy) {
          this.localProxy.stop();
        }
        this.localProxy = new LocalProxy(this.relay);
        await this.localProxy.start();
      }
      // 🔴 URL 加一次性参数：端口复用导致 src 不变时 ArkWeb 不会重载，
      //    换设备/重新配对后会停留在旧电脑的页面上（2026-10-23 回归修复）
      this.webUrl = this.localProxy.url + '?r=' + Date.now();
      this.webLoading = true;
      this.view = 'web';
      this.startStatusLoop();
      hilog.info(0x0000, TAG, '进入 WebView 完整模式: %{public}s', this.webUrl);
    } catch (e) {
      hilog.warn(0x0000, TAG, 'WebView 模式启动失败，等待页待命: %{public}s', (e as Error).message);
      this.view = 'wait';
      this.reportStatus('连接电脑中：' + (e as Error).message);
    } finally {
      this.webStarting = false;
    }
  }

  /** 悬浮状态条数据源：中继灯 = 隧道 WS+E2E 实时状态；协调灯 = 每 5s 直连云端 REST 实测 */
  private startStatusLoop(): void {
    if (this.statusTimer >= 0) {
      return;
    }
    const tick = (): void => {
      this.relayOk = this.relay !== undefined && this.relay.isReady();
      // 🔴 断链超 20s 后恢复 → 自动刷新 WebView（2026-10-26）：
      //    重连成功只救活了隧道，GUI 里挂死的请求要等 30s 超时→502→3s 自愈页才逐个恢复，
      //    体验上仍是"假死"。此处断链恢复后立即 refresh，GUI 一次到位。
      const nowMs: number = Date.now();
      if (this.relayOk) {
        if (this.relayDownSince > 0) {
          const outage: number = nowMs - this.relayDownSince;
          this.relayDownSince = 0;
          if (outage > 20000 && this.view === 'web') {
            hilog.info(0x0000, TAG, '中继恢复（断链 %{public}dms），自动刷新 WebView', outage);
            try { this.webCtrl.refresh(); } catch (e) { /* controller 未附着时忽略 */ }
          }
        }
      } else if (this.relayDownSince === 0) {
        this.relayDownSince = nowMs;
      }
      // 🔴 中继恢复/换代自愈（2026-10-24 事故：断窗期页面僵死，用户只能杀 App）：
      //    web 视图下代理绑的不是当前 relay → 一律重建（不要求 relay 已就绪：
      //    未就绪时 startWeb 落到等待页，就绪后由 onReady 自然恢复——
      //    若此处要求 relayOk，隧道抖动窗口里自愈永远不触发）
      if (this.view === 'web' && this.localProxy && this.localProxy.relay !== this.relay) {
        this.startWeb().catch((): void => {});
      }
      this.checkCoord().catch((): void => {});
    };
    tick();
    this.statusTimer = setInterval(tick, 5000);
  }

  /** 协调服务器连通性：用配对凭证直调云端 /api/v1/pairs（200=通） */
  private async checkCoord(): Promise<void> {
    const meta: DeviceMetaV2 | undefined = this.v2meta;
    if (!meta || !this.store) {
      this.coordOk = false;
      return;
    }
    let cred: string = '';
    try {
      cred = await this.store.getV2Credential(meta.id);
    } catch (e) {
      cred = '';
    }
    if (!cred) {
      this.coordOk = false;
      return;
    }
    const req: http.HttpRequest = http.createHttp();
    try {
      const resp = await req.request(`${httpUrlOf(meta.server)}/api/v1/pairs`, {
        method: http.RequestMethod.GET,
        header: { 'Authorization': `Bearer ${cred}` },
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 5000,
        readTimeout: 5000,
        usingCache: false,
      });
      this.coordOk = resp.responseCode === 200;
    } catch (e) {
      this.coordOk = false;
    } finally {
      req.destroy();
    }
  }

  private basename(path: string): string {
    let base: string = path;
    const bs: number = path.lastIndexOf('\\');
    const fs: number = path.lastIndexOf('/');
    const cutAt: number = bs > fs ? bs : fs;
    if (cutAt >= 0) {
      base = path.substring(cutAt + 1);
    }
    return base;
  }

  @Builder
  pairView() {
    Column({ space: 18 }) {
      Image($r('app.media.whale'))
        .width(110)
        .height(110)
        .borderRadius(24)
      Text('Person Harness').fontSize(24).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
      Text('使用手机访问你电脑上的 DeepSeek harness')
        .fontSize(13).fontColor(SUB)

      Button(this.pairing ? '配对中…' : '扫描二维码配对')
        .onClick(() => { this.scanPair(); })
        .width('100%')
        .height(46)
        .backgroundColor(PRIMARY)
        .fontColor('#FFFFFF')
        .borderRadius(23)
        .enabled(!this.pairing)

      // v2.1 手动配对码入口（无需二维码）：PC 端 /ph pair 输出的 6 位码直接输入。
      // 配对码在云端自带 PC 设备绑定，App 只需默认服务器地址。
      Row({ space: 8 }) {
        TextInput({ placeholder: '输入配对码（如 1A2B3C4D5E）', text: this.manualCode })
          .onChange((v: string) => { this.manualCode = v.trim().toUpperCase(); })
          .layoutWeight(1)
          .height(44)
          .fontSize(14)
          .fontFamily('monospace')
        Button('配对')
          .onClick(() => { this.manualPair(); })
          .height(44)
          .backgroundColor('#1A1A1A')
          .fontColor('#FFFFFF')
          .borderRadius(22)
          .enabled(!this.pairing && this.manualCode.length >= 4)
      }
      .width('100%')

      Column({ space: 6 }) {
        Text('配对说明').fontSize(14).fontWeight(FontWeight.Medium).alignSelf(ItemAlign.Start)
        Text('方式一：PC 对话框输入 /ph pair，把 6 位配对码填到上方输入框')
          .fontSize(12).fontColor(SUB).alignSelf(ItemAlign.Start)
        Text('方式二：在 PC 上打开配对工具，扫描二维码')
          .fontSize(12).fontColor(SUB).alignSelf(ItemAlign.Start)
        Text('配对一次长期有效；提示授权过期时重新配对即可')
          .fontSize(12).fontColor(SUB).alignSelf(ItemAlign.Start)
      }
      .width('100%')
      .padding(12)
      .backgroundColor(CARD)
      .borderRadius(12)

      if (this.pairStatus) {
        Text(this.pairStatus).fontSize(13).fontColor(DANGER)
      }
    }
    .width('100%')
    .padding(16)
  }

  @Builder
  devicesView() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => { this.view = 'list'; })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Text('我的 Agent').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
      }.width('100%')

      Text('点按切换到对应电脑的对话；每台电脑需运行配对工具扫码一次。')
        .fontSize(12).fontColor(SUB).alignSelf(ItemAlign.Start)

      // ---- v2 中继配对（当前主力形态）----
      if (this.v2devices.length > 0) {
        Text('中继配对').fontSize(13).fontColor(SUB).alignSelf(ItemAlign.Start)
      }
      if (this.v2devices.length > 0) {
        List({ space: 8 }) {
          ForEach(this.v2devices, (m: DeviceMetaV2) => {
            ListItem() {
              Row({ space: 10 }) {
                Column({ space: 2 }) {
                  Text(m.name)
                    .fontSize(15)
                    .fontWeight(FontWeight.Medium)
                    .fontColor('#1A1A1A')
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  // 设备编号（云端下发才有；如 #20261023-0008）
                  if (m.seq !== undefined && m.seq !== '') {
                    Text(`#${m.seq}`).fontSize(11).fontColor('#9AA0B0')
                  }
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
                Column({ space: 2 }) {
                  Text(m.server)
                    .fontSize(11)
                    .fontColor('#9AA0B0')
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  if (m.id === this.v2meta?.id) {
                    Text('当前 Agent').fontSize(11).fontColor('#2E8B57')
                  }
                }.alignItems(HorizontalAlign.End)
                if (m.id === this.v2meta?.id) {
                  Text('✓').fontSize(16).fontColor(PRIMARY)
                }
              }
              .width('100%')
              .padding(12)
              .backgroundColor(m.id === this.v2meta?.id ? '#EEF1FF' : CARD)
              .borderRadius(12)
            }
            .onClick(() => { this.switchV2Device(m.id); })
            .swipeAction({ end: this.deleteV2Action(m.id) })
          }, (m: DeviceMetaV2) => m.id)
        }
        .width('100%')
      }


      Button('扫码添加 Agent')
        .onClick(() => { this.scanPair(); })
        .width('100%')
        .height(44)
        .backgroundColor(PRIMARY)
        .fontColor('#FFFFFF')
        .borderRadius(22)
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  @Builder
  deleteV2Action(id: string) {
    Button('删除')
      .fontSize(13)
      .backgroundColor(DANGER)
      .fontColor('#FFFFFF')
      .onClick(() => { this.removeV2Device(id); })
  }

  // ---------------- 工具页：文件互传 / 剪贴板 / 截图 ----------------

  /** 工具请求前置检查：中继未就绪一律拒绝（与 remoteLinkApprove 同规则） */
  private toolReady(): boolean {
    if (this.relay && this.relay.isReady()) {
      return true;
    }
    this.toolStatus = '未连接：中继未就绪，请稍后重试';
    promptAction.showToast({ message: '未连接' });
    return false;
  }

  /** 工具统一 httpCall：JSON 请求 → 解析响应；非 2xx 或带 error 字段则抛错。
   *  longTimeout=true 用于文件分块传输（get-chunk 等）：限速隧道下 1MB 可能跑很久，
   *  普通调用的 15s/30s 超时会把它误杀（2026-10-26 用户实测首次下载被超时截断）。 */
  private async toolCall(path: string, body: string, longTimeout: boolean = false): Promise<Record<string, Object>> {
    if (!this.toolReady()) {
      throw new Error('未连接');
    }
    const res = await this.relay!.httpCall('POST', path, body, longTimeout ? 60000 : 15000, longTimeout ? 300000 : 30000);
    let parsed: Record<string, Object> = {};
    try {
      parsed = JSON.parse(res.bodyText) as Record<string, Object>;
    } catch (e) {
      throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
    }
    if (res.status >= 400 || parsed['error'] !== undefined) {
      throw new Error(String(parsed['error'] ?? `HTTP ${res.status}`));
    }
    return parsed;
  }

  /** 工具页错误提示：状态条 + toast，绝不抛出（不崩溃） */
  private toolFail(prefix: string, e: Object): void {
    const msg: string = this.stripCode((e as Error).message ?? String(e));
    this.toolStatus = `${prefix}：${msg}`;
    promptAction.showToast({ message: this.toolStatus });
    hilog.warn(0x0000, TAG, '工具 %{public}s: %{public}s', prefix, msg);
  }

  private parentOf(p: string): string {
    const cut: number = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return cut > 2 ? p.substring(0, cut) : '';
  }

  private fmtSize(n: number): string {
    if (n < 1024) {
      return `${n} B`;
    }
    if (n < 1024 * 1024) {
      return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // ---------------- 资料检索（/__ph/data/*，电脑端索引，手机端只读） ----------------

  /** 拉取索引概况：已索引文件数（失败静默，仅记日志——索引数只是辅助信息） */
  private async dataLoadSources(): Promise<void> {
    this.dsIndexed = -1;
    try {
      const parsed = await this.toolCall('/__ph/data/sources', '{}');
      const raw: Array<Object> = (parsed['sources'] ?? []) as Array<Object>;
      let total: number = 0;
      raw.forEach((o: Object) => {
        const m = o as Record<string, Object>;
        total += Number(m['files'] ?? 0);
      });
      this.dsIndexed = total;
    } catch (e) {
      hilog.warn(0x0000, TAG, '资料检索 sources 获取失败: %{public}s',
        String((e as Error).message ?? e));
    }
  }

  /** 关键词搜索已索引文档（ext/days 用插件默认值，仅传关键词与条数上限） */
  private async dataSearch(): Promise<void> {
    const q: string = this.dsQuery.trim();
    if (q === '') {
      promptAction.showToast({ message: '请输入关键词' });
      return;
    }
    if (this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    this.toolStatus = '搜索中…';
    try {
      const parsed = await this.toolCall('/__ph/data/search',
        JSON.stringify({ query: q, limit: 20 }));
      const raw: Array<Object> = (parsed['results'] ?? []) as Array<Object>;
      const items: Array<DataSearchItem> = [];
      raw.forEach((o: Object) => {
        const m = o as Record<string, Object>;
        const hitsRaw: Array<Object> = (m['hits'] ?? []) as Array<Object>;
        const hits: Array<string> = [];
        hitsRaw.forEach((h: Object) => {
          hits.push(String(h));
        });
        items.push({
          path: String(m['path'] ?? ''),
          name: String(m['name'] ?? ''),
          size: Number(m['size'] ?? 0),
          mtime: Number(m['mtime'] ?? 0),
          hits: hits,
        });
      });
      this.dsResults = items;
      this.toolStatus = items.length > 0 ? `找到 ${items.length} 个文件` : '';
      if (items.length === 0) {
        this.toolStatus = '未找到，试试更短的关键词';
      }
    } catch (e) {
      this.dsResults = [];
      this.toolFail('搜索失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 查看文件内容（分层预览 2026-10-25）：md/代码→html、图片→PixelMap、Office→PC 转换 html；
   *  from=返回目标页（toolsData / toolsFiles） */
  private async dataRead(item: DataSearchItem, from: string = 'toolsData'): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    this.toolStatus = `正在打开「${item.name}」…`;
    try {
      this.dataReadBack = from;
      let parsed: Record<string, Object> = {};
      let previewErr: string = '';
      try {
        parsed = await this.toolCall('/__ph/file/preview', JSON.stringify({ path: item.path })) as Record<string, Object>;
      } catch (e) {
        previewErr = String((e as Error).message ?? e);
      }
      const kind: string = String(parsed['kind'] ?? '');
      if (kind === 'image') {
        const b64: string = String(parsed['b64'] ?? '');
        const u8: Uint8Array = this.b64Helper.decodeSync(b64);
        const ab: ArrayBuffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
        const src = imageKit.createImageSource(ab);
        this.previewPixel = await src.createPixelMap();
        this.previewKind = 'image';
        this.dsReadPath = item.path;
        this.dsReadContent = '';
        this.previewHtml = '';
        this.toolStatus = '';
        this.view = 'toolsDataRead';
        return;
      }
      if (kind === 'html') {
        this.previewHtml = String(parsed['content'] ?? '');
        this.previewPixel = undefined;
        this.previewKind = 'html';
        this.dsReadPath = item.path;
        this.dsReadContent = '';
        this.toolStatus = '';
        this.view = 'toolsDataRead';
        return;
      }
      if (previewErr !== '') {
        // 预览端点报错（不支持/未装 LibreOffice/超限）→ 提示 + 回落旧文本读取
        this.toolStatus = `⚠️ ${previewErr}（尝试以文本打开）`;
      }
      const old = await this.toolCall('/__ph/data/read', JSON.stringify({ path: item.path, maxKB: 64 }));
      this.dsReadPath = item.path;
      this.dsReadContent = String(old['content'] ?? '');
      this.previewKind = '';
      this.previewHtml = '';
      this.previewPixel = undefined;
      this.toolStatus = previewErr !== '' ? `⚠️ ${previewErr}` : '';
      this.view = 'toolsDataRead';
    } catch (e) {
      this.toolFail('读取失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 浏览电脑目录：'__quick__'=快捷起始页（2026-10-25）；'' = 用户主目录；'__drives__' = 盘符列表 */
  private async loadToolDir(path: string): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    this.toolStatus = '加载目录中…';
    this.selMode = false;
    this.selItems = [];
    try {
      const parsed = await this.toolCall('/__ph/files/list', JSON.stringify({ path: path }));
      if (path === '__quick__') {
        const quickRaw: Array<Object> = (parsed['quick'] ?? []) as Array<Object>;
        const items: Array<ToolFileItem> = [];
        quickRaw.forEach((o: Object) => {
          const m = o as Record<string, Object>;
          if (m['exists'] !== true) {
            return; // 电脑上没有的入口不显示
          }
          items.push({ name: String(m['name'] ?? ''), dir: true, size: 0, mtime: 0, path: String(m['path'] ?? ''), quick: true });
        });
        this.toolPath = '__quick__';
        this.toolNavRoot = true;
        this.toolFiles = items;
        this.toolStatus = '';
        return;
      }
      if (path === '__drives__') {
        const rootsRaw: Array<Object> = (parsed['roots'] ?? []) as Array<Object>;
        const items: Array<ToolFileItem> = [];
        rootsRaw.forEach((o: Object) => {
          const m = o as Record<string, Object>;
          const full: string = String(m['path'] ?? '');
          items.push({ name: full, dir: true, size: 0, mtime: 0 });
        });
        this.toolPath = '__drives__';
        this.toolNavRoot = true;
        this.toolFiles = items;
        this.toolStatus = items.length > 0 ? '' : '（未枚举到磁盘）';
        return;
      }
      const raw: Array<Object> = (parsed['items'] ?? []) as Array<Object>;
      const items: Array<ToolFileItem> = [];
      raw.forEach((o: Object) => {
        const m = o as Record<string, Object>;
        items.push({
          name: String(m['name'] ?? ''),
          dir: m['dir'] === true,
          size: Number(m['size'] ?? 0),
          mtime: Number(m['mtime'] ?? 0),
        });
      });
      this.toolPath = String(parsed['path'] ?? path);
      // 盘符根（如 C:\）也算"到顶"：‹ 返回工具列表
      this.toolNavRoot = /^[a-zA-Z]:\\?$/.test(this.toolPath);
      this.toolFiles = items;
      this.toolStatus = items.length > 0 ? '' : '（空目录）';
    } catch (e) {
      this.toolFail('读取目录失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 列表项完整路径（快捷项自带 path；普通项 = toolPath\name；盘符项 = name） */
  private fullPathOf(item: ToolFileItem): string {
    if (item.quick || this.toolPath === '__drives__' || this.toolPath === '__quick__') {
      return item.path ?? item.name;
    }
    return this.toolPath ? `${this.toolPath}\\${item.name}` : item.name;
  }

  /** 多选：切换某项选中态 */
  private toggleSel(item: ToolFileItem): void {
    const full: string = this.fullPathOf(item);
    const next: Array<SelItem> = this.selItems.filter((s: SelItem): boolean => s.path !== full);
    if (next.length === this.selItems.length) {
      next.push({ path: full, name: item.name, dir: item.dir, size: item.size });
    }
    this.selItems = next;
  }

  private isSel(item: ToolFileItem): boolean {
    const full: string = this.fullPathOf(item);
    return this.selItems.find((s: SelItem): boolean => s.path === full) !== undefined;
  }

  /** 点击列表项：选择模式=勾选；快捷页/盘符页=进入；文件夹=进入；文件=下载到手机 */
  private async onToolFileTap(item: ToolFileItem): Promise<void> {
    if (this.selMode) {
      this.toggleSel(item);
      return;
    }
    if (this.toolBusy) {
      return;
    }
    if (this.toolPath === '__quick__' || this.toolPath === '__drives__' || item.quick) {
      // 快捷/盘符列表：item.path（或盘符名）即完整路径
      await this.loadToolDir(item.quick ? (item.path ?? item.name) : item.name);
      return;
    }
    if (item.dir) {
      const next: string = this.toolPath ? `${this.toolPath}\\${item.name}` : item.name;
      await this.loadToolDir(next);
      return;
    }
    // 断点续传：点击显示「点此续传」的同一文件项 → 从断点继续
    const full: string = this.fullPathOf(item);
    if (this.dlResume && this.dlItemPath === full) {
      this.resumeDownload(full);
      return;
    }
    if (item.size > 500 * 1024 * 1024) {
      this.toolStatus = `「${item.name}」超过 500MB，手机端不支持（请到电脑下载）`;
      promptAction.showToast({ message: '文件超过 500MB，手机端不支持' });
      return;
    }
    this.toolBusy = true;
    this.toolStatus = `正在下载「${item.name}」…`;
    this.dlItemPath = full;
    this.dlText = '准备下载…';
    this.dlResume = false;
    try {
      // 分块下载（2026-10-26）：1MB/块经 /__ph/file/get-chunk 拉取，逐块直写文件——
      // 不再整文件 base64 进内存，不堵共享隧道；服务端限速（transferThrottleKbps）自动生效
      const CHUNK: number = 1024 * 1024;
      const first = await this.toolCall('/__ph/file/get-chunk',
        JSON.stringify({ path: full, offset: 0, size: CHUNK }), true);
      if (first && first['error']) {
        throw new Error(String(first['error']));
      }
      const total: number = Number(first['size'] ?? 0);
      const name: string = first['name'] ? String(first['name']) : item.name;
      if (total <= 0) {
        throw new Error('电脑返回的文件为空');
      }
      this.dlName = name;
      this.dlTotal = total;
      const firstBytes: Uint8Array = this.b64Helper.decodeSync(String(first['b64'] ?? ''));
      let offset: number = Number(first['offset'] ?? 0) + Number(first['len'] ?? firstBytes.length);
      // 打开输出通道：系统保存选择器（默认可存 Download），取消则回落应用沙箱
      let target: fileIo.File | null = null;
      let savedTo: string = '';
      try {
        const docPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker();
        const opts: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
        opts.newFileNames = [name];
        const uris: Array<string> = await docPicker.save(opts);
        if (uris && uris.length > 0) {
          target = fileIo.openSync(uris[0], fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
          savedTo = uris[0];
        }
      } catch (e) {
        // 选择器不可用/取消 → 沙箱兜底
      }
      let savePath = '';
      if (target === null) {
        const dir: string = `${getContext(this).filesDir}/download`;
        try {
          fileIo.mkdirSync(dir, true);
        } catch (e) {
          // 已存在
        }
        savePath = `${dir}/${name}`;
        target = fileIo.openSync(savePath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      }
      this.dlTarget = savedTo !== '' ? savedTo : savePath;
      this.dlSaveJob(full);
      fileIo.writeSync(target.fd, firstBytes.buffer as ArrayBuffer, { offset: firstBytes.byteOffset, length: firstBytes.byteLength });
      await this.runDownloadChunks(full, name, total, target, offset);
      this.dlClearJob();
      this.dlItemPath = '';
      this.dlText = '';
      if (savedTo === '') {
        this.toolStatus = `已保存（应用目录）：${savePath}`;
        promptAction.showToast({ message: `✅ 已下载「${name}」（应用目录）` });
      } else {
        this.toolStatus = `✅ 已保存：${savedTo}`;
        promptAction.showToast({ message: `✅ 已下载「${name}」到所选位置` });
      }
    } catch (e) {
      // 下载中断：不清断点，文件项下方显示「点此续传」，任务已持久化可跨重启续传
      if (this.dlTotal > 0) {
        this.dlResume = true;
        this.dlText = '⏸ 下载中断，点此续传';
        this.dlSaveJob(full);
      } else {
        this.dlItemPath = '';
        this.dlText = '';
      }
      this.toolFail('下载失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 分块拉取续写公共循环（新下载 / 续传共用）：1MB/块直写 target，末尾 fsync 并关闭。
   *  offset 为已写入字节数；每块更新文件项下方的 dlText 进度行。 */
  private async runDownloadChunks(full: string, name: string, total: number, target: fileIo.File, offset: number): Promise<void> {
    const CHUNK: number = 1024 * 1024;
    try {
      while (offset < total) {
        const parsed = await this.toolCall('/__ph/file/get-chunk',
          JSON.stringify({ path: full, offset: offset, size: CHUNK }), true);
        if (parsed && parsed['error']) {
          throw new Error(String(parsed['error']));
        }
        const part: Uint8Array = this.b64Helper.decodeSync(String(parsed['b64'] ?? ''));
        if (part.byteLength === 0) {
          // 服务端异常/文件中途变化：offset 不会再前进，不中断就在这里死循环
          throw new Error('电脑返回空数据块（文件可能已变化），下载中断');
        }
        fileIo.writeSync(target.fd, part.buffer as ArrayBuffer, { offset: part.byteOffset, length: part.byteLength });
        offset = Number(parsed['offset'] ?? offset) + Number(parsed['len'] ?? part.length);
        const prog: string = `${(offset / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`;
        this.dlText = `下载中 ${prog}`;
        this.toolStatus = `下载中「${name}」${prog}`;
      }
      fileIo.fsync(target.fd);
    } finally {
      fileIo.closeSync(target);
    }
  }

  /** 断点续传：APPEND 模式打开原目标（picker 授权过期则回落应用沙箱目录），从已有大小继续 */
  private async resumeDownload(full: string): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    const total: number = this.dlTotal;
    const name: string = this.dlName;
    if (name === '' || total <= 0) {
      this.dlResume = false;
      return;
    }
    this.toolBusy = true;
    this.dlResume = false;
    this.toolStatus = `正在续传「${name}」…`;
    try {
      let targetStr: string = this.dlTarget;
      let target: fileIo.File | null = null;
      if (targetStr !== '') {
        try {
          target = fileIo.openSync(targetStr, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
        } catch (e) {
          target = null; // picker 授权已过期
        }
      }
      if (target === null) {
        const dir: string = `${getContext(this).filesDir}/download`;
        try {
          fileIo.mkdirSync(dir, true);
        } catch (e) {
          // 已存在
        }
        targetStr = `${dir}/${name}`;
        target = fileIo.openSync(targetStr, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.APPEND);
        this.dlTarget = targetStr;
        this.dlSaveJob(full);
      }
      const st = fileIo.statSync(target.fd);
      let offset: number = st.size;
      if (offset >= total) {
        fileIo.closeSync(target);
        this.dlClearJob();
        this.dlItemPath = '';
        this.dlText = '';
        this.toolStatus = `✅ 「${name}」已完整（${(total / 1048576).toFixed(1)}MB）`;
        return;
      }
      this.dlText = `下载中 ${(offset / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB`;
      await this.runDownloadChunks(full, name, total, target, offset);
      this.dlClearJob();
      this.dlItemPath = '';
      this.dlText = '';
      this.toolStatus = `✅ 已续传完成「${name}」`;
      promptAction.showToast({ message: `✅ 已续传完成「${name}」` });
    } catch (e) {
      this.dlResume = true;
      this.dlText = '⏸ 下载中断，点此续传';
      this.dlSaveJob(full);
      this.toolFail('续传失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 续传任务持久化到 preferences（失败静默，不阻塞下载流程） */
  private dlSaveJob(full: string): void {
    try {
      const prefs = preferences.getPreferencesSync(getContext(this), { name: 'hh_dljob' });
      prefs.putSync('job', JSON.stringify({
        path: full, name: this.dlName, total: this.dlTotal, target: this.dlTarget,
      }));
      prefs.flushSync();
    } catch (e) {
      // 持久化失败不影响本次下载
    }
  }

  /** 清除续传任务（下载成功/已完整时） */
  private dlClearJob(): void {
    try {
      const prefs = preferences.getPreferencesSync(getContext(this), { name: 'hh_dljob' });
      prefs.deleteSync('job');
      prefs.flushSync();
    } catch (e) {
      // 忽略
    }
  }

  /** 启动时恢复中断的下载任务：任务存在即在对应文件项下方显示「点此续传」 */
  private dlLoadJob(): void {
    try {
      const prefs = preferences.getPreferencesSync(getContext(this), { name: 'hh_dljob' });
      // 批量任务恢复（key='batch'，独立于单文件任务）
      const rawB: string = prefs.getSync('batch', '') as string;
      if (rawB !== '') {
        const bj: Record<string, Object> = JSON.parse(rawB) as Record<string, Object>;
        const arr: Array<TreeFile> = (bj['files'] ?? []) as Array<TreeFile>;
        const idx: number = Number(bj['i'] ?? 0);
        if (arr.length > 0 && idx < arr.length) {
          this.batchFiles = arr;
          this.batchIndex = Math.max(0, idx);
          this.batchLeft = arr.length - this.batchIndex;
        } else {
          prefs.deleteSync('batch');
          prefs.flushSync();
        }
      }
      const raw: string = prefs.getSync('job', '') as string;
      if (raw === '') {
        return;
      }
      const job: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      const full: string = String(job['path'] ?? '');
      const name: string = String(job['name'] ?? '');
      const total: number = Number(job['total'] ?? 0);
      const target: string = String(job['target'] ?? '');
      if (full === '' || name === '' || total <= 0) {
        return;
      }
      this.dlItemPath = full;
      this.dlName = name;
      this.dlTotal = total;
      this.dlTarget = target;
      this.dlResume = true;
      this.dlText = '⏸ 下载中断，点此续传';
    } catch (e) {
      // 恢复失败按无任务处理
    }
  }

  /** 上传到电脑：多选文件 → base64 → /__ph/file/put；>1MB 走分片 put-chunk（2026-10-26）
   *  2026-10-25：maxNumber=99；当前在真实目录浏览时 dir=该目录（照片直进图库等工作流），快捷页/盘符页=收件箱
   *  分片按 1MB 读文件，不全量进内存；服务端 1GB 兜底，超限时服务端会报错提示 */
  private async uploadToPc(): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    try {
      const opts: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
      opts.maxSelectNumber = 99;
      const docPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker();
      const picked: Array<string> = await docPicker.select(opts);
      const uris: Array<string> = picked;
      if (uris.length === 0) {
        return; // 用户取消
      }
      const targetDir: string = (this.toolPath !== '' && this.toolPath !== '__quick__' && this.toolPath !== '__drives__')
        ? this.toolPath : '';
      let ok = 0;
      for (let i = 0; i < uris.length; i++) {
        const uri: string = uris[i];
        const f = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
        try {
          const st = fileIo.statSync(f.fd);
          const name: string = this.basename(decodeURIComponent(uri)) || `upload-${i}.bin`;
          this.toolBusy = true;
          const CHUNK: number = 1024 * 1024;
          if (st.size <= CHUNK) {
            const buf: ArrayBuffer = new ArrayBuffer(st.size);
            fileIo.readSync(f.fd, buf);
            this.toolStatus = `上传中 ${i + 1}/${uris.length}：「${name}」…`;
            const b64: string = this.b64Helper.encodeToStringSync(new Uint8Array(buf));
            const parsed = await this.toolCall('/__ph/file/put',
              JSON.stringify({ name: name, b64: b64, dir: targetDir }), true);
            if (parsed && parsed['error']) {
              throw new Error(String(parsed['error']));
            }
          } else {
            // 大文件分片（2026-10-26）：1MB/块发 /__ph/file/put-chunk，逐块读文件
            const n: number = Math.ceil(st.size / CHUNK);
            const uploadId: string = `${Date.now().toString(36)}${(Math.floor(Math.random() * 46656)).toString(36)}`;
            for (let seq = 1; seq <= n; seq++) {
              const len: number = Math.min(CHUNK, st.size - (seq - 1) * CHUNK);
              const buf: ArrayBuffer = new ArrayBuffer(len);
              fileIo.readSync(f.fd, buf);
              this.toolStatus = `上传中 ${i + 1}/${uris.length}「${name}」分片 ${seq}/${n}…`;
              const b64: string = this.b64Helper.encodeToStringSync(new Uint8Array(buf));
              const parsed = await this.toolCall('/__ph/file/put-chunk',
                JSON.stringify({ uploadId: uploadId, seq: seq, n: n, name: name, dir: targetDir, b64: b64, fin: seq === n }), true);
              if (parsed && parsed['error']) {
                throw new Error(String(parsed['error']));
              }
            }
          }
          ok++;
          this.toolStatus = `已传 ${ok}/${uris.length}，最新：「${name}」`;
        } finally {
          fileIo.closeSync(f);
        }
      }
      this.toolStatus = `✅ 已上传 ${ok}/${uris.length} 个文件${targetDir ? ` → ${targetDir}` : '（收件箱）'}`;
      promptAction.showToast({ message: `✅ 已传 ${ok}/${uris.length} 个文件` });
    } catch (e) {
      this.toolFail('上传失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 批量下载（多选）：文件直存应用下载目录；文件夹先 files/tree 收集再逐个取回。
   *  分块取回（2026-10-26）：1MB/块直写文件；单文件 ≤500MB（手机端实用上限，插件侧 1GB 兜底）。
   *  断点续传（2026-10-26）：清单与进度持久化，中断后列表上方出现续传条，点「继续」从未完成文件接着取。 */
  private async batchDownload(): Promise<void> {
    if (this.toolBusy || this.selItems.length === 0) {
      return;
    }
    this.toolBusy = true;
    const dlDir: string = `${getContext(this).filesDir}/download`;
    try {
      fileIo.mkdirSync(dlDir, true);
    } catch (e) {
      // 已存在
    }
    let ok = 0;
    let skip = 0;
    try {
      // 先展开全部待取清单（文件夹 → files/tree），再统一逐个取回
      this.batchFiles = [];
      for (const sel of this.selItems) {
        if (sel.dir) {
          this.toolStatus = `清点文件夹「${sel.name}」…`;
          const tree = await this.toolCall('/__ph/files/tree', JSON.stringify({ path: sel.path }));
          const filesRaw: Array<Object> = (tree['files'] ?? []) as Array<Object>;
          filesRaw.forEach((o: Object) => {
            const m = o as Record<string, Object>;
            const tf: TreeFile = { path: String(m['path'] ?? ''), rel: `${this.safeDirName(sel.name)}/${String(m['rel'] ?? '')}`, size: Number(m['size'] ?? 0) };
            this.batchFiles.push(tf);
          });
          if (tree['truncated'] === true) {
            this.toolStatus = `⚠️「${sel.name}」过大被截断，只取前 2000 个/500MB`;
          }
        } else {
          this.batchFiles.push({ path: sel.path, rel: this.safeDirName(sel.name), size: sel.size });
        }
      }
      this.batchIndex = 0;
      this.batchSaveJob();
      for (; this.batchIndex < this.batchFiles.length; this.batchIndex++) {
        const one: TreeFile = this.batchFiles[this.batchIndex];
        if (one.size > 500 * 1024 * 1024) {
          skip++;
          continue;
        }
        this.toolStatus = `取回中（${this.batchIndex + 1}/${this.batchFiles.length}）：${one.rel}`;
        const done: boolean = await this.batchFetchOne(one, dlDir);
        if (done) {
          ok++;
        } else {
          skip++;
        }
        this.batchSaveJob();
      }
      this.batchClearJob();
      this.batchLeft = 0;
      this.batchFiles = [];
      this.batchIndex = 0;
      this.toolStatus = `✅ 批量取回完成：${ok} 个文件${skip > 0 ? `（跳过 ${skip} 个：超限/空）` : ''} → ${dlDir}`;
      promptAction.showToast({ message: `✅ 已取回 ${ok} 个文件` });
      this.selMode = false;
      this.selItems = [];
    } catch (e) {
      // 中断：保留断点，列表上方显示续传条
      this.batchSaveJob();
      this.batchLeft = this.batchFiles.length - this.batchIndex;
      this.toolFail('批量下载中断', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 批量取回单个文件到应用下载目录；已存在部分文件时 APPEND 续写（断点续传）。
   *  返回 true=取回成功/本已完整；false=跳过（空文件）。 */
  private async batchFetchOne(one: TreeFile, dlDir: string): Promise<boolean> {
    const savePath: string = `${dlDir}/${one.rel.replaceAll('\\', '/')}`;
    // 建子目录（文件夹传送保持结构）
    const slash: number = savePath.lastIndexOf('/');
    try {
      fileIo.mkdirSync(savePath.substring(0, slash), true);
    } catch (e) {
      // 已存在
    }
    // APPEND 打开：上次中断的部分文件直接续写
    let f: fileIo.File;
    let offset: number = 0;
    try {
      f = fileIo.openSync(savePath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
      offset = fileIo.statSync(f.fd).size;
    } catch (e) {
      f = fileIo.openSync(savePath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    }
    let total: number = -1;
    try {
      if (offset > 0) {
        // 已有一部分：探测远端总大小（1 字节探针），已完整则直接返回
        const probe = await this.toolCall('/__ph/file/get-chunk',
          JSON.stringify({ path: one.path, offset: 0, size: 1 }), true);
        if (probe && probe['error']) {
          throw new Error(String(probe['error']));
        }
        total = Number(probe['size'] ?? 0);
        if (offset >= total) {
          return true;
        }
      } else {
        // 新文件：首块拿到 total + 首批数据
        const CHUNK: number = 1024 * 1024;
        const first = await this.toolCall('/__ph/file/get-chunk',
          JSON.stringify({ path: one.path, offset: 0, size: CHUNK }), true);
        if (first && first['error']) {
          throw new Error(String(first['error']));
        }
        total = Number(first['size'] ?? 0);
        if (total <= 0) {
          return false; // 空文件，跳过
        }
        const firstBytes: Uint8Array = this.b64Helper.decodeSync(String(first['b64'] ?? ''));
        fileIo.writeSync(f.fd, firstBytes.buffer as ArrayBuffer, { offset: firstBytes.byteOffset, length: firstBytes.byteLength });
        offset = Number(first['offset'] ?? 0) + Number(first['len'] ?? firstBytes.length);
      }
      this.dlItemPath = one.path; // 进度行显示在该文件项下方
      await this.runDownloadChunks(one.path, one.rel, total, f, offset);
      return true;
    } finally {
      this.dlItemPath = '';
      this.dlText = '';
    }
  }

  /** 批量下载断点续传：点续传条「继续」触发，从 batchIndex 接着取 */
  private async resumeBatch(): Promise<void> {
    if (this.toolBusy || this.batchLeft <= 0) {
      return;
    }
    this.toolBusy = true;
    const dlDir: string = `${getContext(this).filesDir}/download`;
    try {
      fileIo.mkdirSync(dlDir, true);
    } catch (e) {
      // 已存在
    }
    let ok = 0;
    try {
      for (; this.batchIndex < this.batchFiles.length; this.batchIndex++) {
        const one: TreeFile = this.batchFiles[this.batchIndex];
        this.toolStatus = `续传批量取回（${this.batchIndex + 1}/${this.batchFiles.length}）：${one.rel}`;
        const done: boolean = await this.batchFetchOne(one, dlDir);
        if (done) {
          ok++;
        }
        this.batchSaveJob();
        this.batchLeft = this.batchFiles.length - this.batchIndex - 1;
      }
      this.batchClearJob();
      this.batchLeft = 0;
      this.batchFiles = [];
      this.batchIndex = 0;
      this.toolStatus = `✅ 批量取回完成（含续传 ${ok} 个）→ ${dlDir}`;
      promptAction.showToast({ message: `✅ 批量取回完成（含续传 ${ok} 个）` });
    } catch (e) {
      this.batchSaveJob();
      this.batchLeft = this.batchFiles.length - this.batchIndex;
      this.toolFail('批量续传失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 批量任务进度持久化（prefs key='batch'，与单文件续传的 'job' 同库不同键） */
  private batchSaveJob(): void {
    try {
      const prefs = preferences.getPreferencesSync(getContext(this), { name: 'hh_dljob' });
      prefs.putSync('batch', JSON.stringify({ files: this.batchFiles, i: this.batchIndex + 1 }));
      prefs.flushSync();
    } catch (e) {
      // 持久化失败不阻塞
    }
  }

  private batchClearJob(): void {
    try {
      const prefs = preferences.getPreferencesSync(getContext(this), { name: 'hh_dljob' });
      prefs.deleteSync('batch');
      prefs.flushSync();
    } catch (e) {
      // 忽略
    }
  }

  /** 目录名转安全文件名（批量下载子目录用） */
  private safeDirName(name: string): string {
    return name.replaceAll('\\', '_').replaceAll('/', '_').replaceAll(':', '_') || 'dir';
  }

  /** 在当前浏览目录新建文件夹（2026-10-25：传文件前建目标目录） */
  private async mkdirHere(): Promise<void> {
    const name: string = this.mkdirName.trim();
    this.mkdirVisible = false;
    if (name === '' || this.toolBusy) {
      this.mkdirName = '';
      return;
    }
    if (this.toolPath === '' || this.toolPath === '__quick__' || this.toolPath === '__drives__') {
      promptAction.showToast({ message: '先进入一个具体目录再新建文件夹' });
      this.mkdirName = '';
      return;
    }
    this.mkdirName = '';
    this.toolBusy = true;
    this.toolStatus = `新建文件夹「${name}」…`;
    try {
      await this.toolCall('/__ph/files/mkdir', JSON.stringify({ path: `${this.toolPath}\\${name}` }));
      this.toolStatus = `✅ 已新建「${name}」，上传将传入此目录`;
      promptAction.showToast({ message: `✅ 已新建 ${name}` });
      await this.loadToolDir(`${this.toolPath}\\${name}`); // 直接进入新目录
    } catch (e) {
      this.toolFail('新建文件夹失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 剪贴板：从电脑取 → 存入手机剪贴板并显示 */
  private async clipFromPc(): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    this.toolStatus = '正在从电脑取剪贴板…';
    try {
      const parsed = await this.toolCall('/__ph/clipboard/get', '{}');
      const text: string = String(parsed['text'] ?? '');
      if (text) {
        const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
        pasteboard.getSystemPasteboard().setPasteData(data);
      }
      this.clipText = text;
      this.toolStatus = text ? '✅ 已取到并复制到手机剪贴板' : '电脑剪贴板是空的';
      promptAction.showToast({ message: this.toolStatus });
    } catch (e) {
      this.toolFail('取剪贴板失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 剪贴板：读手机剪贴板 → 发送到电脑 */
  private async clipToPc(): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    this.toolStatus = '正在发送到电脑…';
    try {
      const data: pasteboard.PasteData = await pasteboard.getSystemPasteboard().getData();
      const text: string = data.getPrimaryText() ?? '';
      if (!text) {
        this.toolStatus = '手机剪贴板是空的';
        promptAction.showToast({ message: '手机剪贴板是空的' });
        return;
      }
      await this.toolCall('/__ph/clipboard/set', JSON.stringify({ text: text }));
      this.clipText = text;
      this.toolStatus = '✅ 已发送到电脑剪贴板';
      promptAction.showToast({ message: this.toolStatus });
    } catch (e) {
      this.toolFail('发送剪贴板失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 截图：电脑截屏 → 存到应用沙箱并预览（不申请相册权限，实现最简） */
  private async takeScreenshot(): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    this.toolStatus = '正在截图…';
    this.shotPreview = '';
    try {
      const parsed = await this.toolCall('/__ph/screenshot', '{}');
      const b64: string = String(parsed['b64'] ?? '');
      if (!b64) {
        throw new Error('电脑未返回截图内容');
      }
      const bytes: Uint8Array = this.b64Helper.decodeSync(b64);
      const dir: string = `${getContext(this).filesDir}/screenshots`;
      try {
        fileIo.mkdirSync(dir, true);
      } catch (e) {
        // 已存在
      }
      const savePath: string = `${dir}/shot_${Date.now()}.png`;
      const f = fileIo.openSync(savePath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(f.fd, bytes.buffer as ArrayBuffer);
      fileIo.closeSync(f);
      this.shotPath = savePath;
      this.shotPreview = `data:image/png;base64,${b64}`;
      this.toolStatus = '截图完成，可点「💾 保存到下载」存到手机下载目录';
      promptAction.showToast({ message: '✅ 截图完成' });
    } catch (e) {
      this.toolFail('截图失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 把已落盘的截图复制到用户选择的位置（默认 Download），失败提示沙箱路径 */
  private async saveShotToDownload(): Promise<void> {
    if (this.shotPath === '' || this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    try {
      const docPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker();
      const opts: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
      opts.newFileNames = [`shot_${Date.now()}.png`];
      const uris: Array<string> = await docPicker.save(opts);
      if (uris && uris.length > 0) {
        const src = fileIo.openSync(this.shotPath, fileIo.OpenMode.READ_ONLY);
        const st = fileIo.statSync(src.fd);
        const buf = new ArrayBuffer(st.size);
        fileIo.readSync(src.fd, buf);
        fileIo.closeSync(src);
        const dst = fileIo.openSync(uris[0], fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
        // 🔴 读出后显式长度写入 + fsync（copyFile 对 picker URI 曾产出 0B 文件，2026-10-24）
        fileIo.writeSync(dst.fd, buf, { length: st.size });
        fileIo.fsync(dst.fd);
        fileIo.closeSync(dst);
        this.toolStatus = `✅ 已保存到：${uris[0]}`;
        promptAction.showToast({ message: '✅ 已保存到所选位置' });
      } else {
        promptAction.showToast({ message: `未保存。截图在应用目录：${this.shotPath}` });
      }
    } catch (e) {
      this.toolFail('保存失败', e as Object);
      promptAction.showToast({ message: `未保存。截图在应用目录：${this.shotPath}` });
    } finally {
      this.toolBusy = false;
    }
  }

  /** 窗口实况：拉取电脑窗口列表（/__ph/windows/list） */
  private async loadLiveWindows(): Promise<void> {
    if (this.toolBusy) {
      return;
    }
    this.toolBusy = true;
    this.toolStatus = '正在获取窗口列表…';
    try {
      const parsed = await this.toolCall('/__ph/windows/list', '{}');
      const raw: Array<Object> = (parsed['windows'] ?? []) as Array<Object>;
      const items: Array<LiveWindowItem> = [];
      raw.forEach((o: Object) => {
        const m = o as Record<string, Object>;
        items.push({
          hwnd: String(m['hwnd'] ?? ''),
          title: String(m['title'] ?? ''),
          w: Number(m['w'] ?? 0),
          h: Number(m['h'] ?? 0),
          minimized: m['minimized'] === true,
        });
      });
      this.liveWindows = items;
      this.toolStatus = items.length > 0 ? `共 ${items.length} 个窗口，选择一个开始实况` : '电脑上没有可用的窗口';
    } catch (e) {
      this.toolFail('获取窗口列表失败', e as Object);
    } finally {
      this.toolBusy = false;
    }
  }

  /** 窗口实况：选中窗口 → 开启 800ms 轮询 */
  private pickLiveWindow(item: LiveWindowItem): void {
    if (this.liveRunning) {
      this.stopLiveLoop();
    }
    this.liveHwnd = item.hwnd;
    this.liveTitle = item.title;
    this.liveFrame = '';
    this.liveFrames = 0;
    this.liveW = 0;
    this.liveH = 0;
    this.toolStatus = '';
    this.liveRunning = true;
    this.setLiveOrientation(true); // 实况横屏（看视频类画面竖屏看不清）
    this.pollLiveFrame(); // 立即拉第一帧
    this.liveTimer = setInterval(() => {
      this.pollLiveFrame();
    }, 800);
  }

  /** 实况页横竖屏切换（window API 失败静默——部分设备/窗口环境可能受限） */
  private setLiveOrientation(land: boolean): void {
    window.getLastWindow(getContext(this)).then((win: window.Window) => {
      return win.setPreferredOrientation(land ? window.Orientation.LANDSCAPE : window.Orientation.PORTRAIT);
    }).catch((e: Object) => {
      hilog.warn(0x0000, TAG, 'setPreferredOrientation 失败: %{public}s', String(e));
    });
  }

  /** 实况全屏切换（2026-10-27）：进入=隐藏系统状态栏/导航栏 + 隐藏页面状态行；退出=恢复 */
  private toggleLiveFullscreen(on: boolean): void {
    this.liveFullscreen = on;
    window.getLastWindow(getContext(this)).then((win: window.Window) => {
      return win.setWindowSystemBarEnable(on ? [] : ['status', 'navigation']);
    }).catch((e: Object) => {
      hilog.warn(0x0000, TAG, 'setWindowSystemBarEnable 失败: %{public}s', String(e));
    });
  }

  /** 窗口实况：拉一帧（上一帧未返回时跳过本轮，防请求叠加） */
  private async pollLiveFrame(): Promise<void> {
    if (!this.liveRunning || this.liveBusy || this.liveHwnd === '') {
      return;
    }
    this.liveBusy = true;
    try {
      const parsed = await this.toolCall('/__ph/live/frame',
        JSON.stringify({ hwnd: this.liveHwnd, title: this.liveTitle, maxW: 1920, q: 60 }));
      if (!this.liveRunning) {
        return; // 轮询已停止，丢弃迟到的帧
      }
      if (parsed['changed'] === true) {
        const b64: string = String(parsed['b64'] ?? '');
        if (b64) {
          this.liveFrame = `data:image/jpeg;base64,${b64}`;
          this.liveFrames = this.liveFrames + 1;
          this.liveW = Number(parsed['w'] ?? 0);
          this.liveH = Number(parsed['h'] ?? 0);
          this.toolStatus = '';
        }
      }
      // changed:false：画面静止，跳过（零流量）
    } catch (e) {
      if (this.liveRunning) {
        const msg: string = this.stripCode((e as Error).message ?? String(e));
        this.toolStatus = `实况拉帧失败：${msg}`;
      }
    } finally {
      this.liveBusy = false;
    }
  }

  /** 窗口实况：停止轮询并清实况状态（按钮/返回子页共用） */
  private stopLiveLoop(): void {
    if (this.liveTimer >= 0) {
      clearInterval(this.liveTimer);
      this.liveTimer = -1;
    }
    this.liveRunning = false;
    this.liveHwnd = '';
    this.liveTitle = '';
    this.liveFrame = '';
    this.liveFrames = 0;
    this.liveScale = 1; // 复位缩放/拖动
    this.liveTx = 0;
    this.liveTy = 0;
    if (this.liveFullscreen) {
      this.toggleLiveFullscreen(false); // 退出全屏（恢复系统栏）
    }
    this.setLiveOrientation(false); // 恢复竖屏
  }

  /** 窗口实况：点击画面回传归一化坐标（/__ph/click），403 = 窗口已不在实况状态 */
  private async onLiveTap(nx: number, ny: number): Promise<void> {
    if (this.liveHwnd === '' || this.toolBusy) {
      return;
    }
    const x: number = Math.min(1, Math.max(0, nx));
    const y: number = Math.min(1, Math.max(0, ny));
    this.toolBusy = true;
    try {
      const parsed = await this.toolCall('/__ph/click',
        JSON.stringify({ hwnd: this.liveHwnd, x: x, y: y, title: this.liveTitle }));
      const sx: number = Number(parsed['sx'] ?? 0);
      const sy: number = Number(parsed['sy'] ?? 0);
      promptAction.showToast({ message: `已点击 (${sx},${sy})` });
    } catch (e) {
      const msg: string = this.stripCode((e as Error).message ?? String(e));
      if (msg.indexOf('403') >= 0) {
        this.toolStatus = '窗口已不在实况状态';
        promptAction.showToast({ message: '窗口已不在实况状态' });
      } else {
        this.toolFail('点击回传失败', e as Object);
      }
    } finally {
      this.toolBusy = false;
    }
  }

  /** 工具主页：三张入口卡片 */
  @Builder
  toolsView() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => {
          this.view = this.webIntent && this.webUrl !== '' ? 'web' : 'wait';
        })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Text('工具').fontSize(18).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
      }.width('100%')

      Text(`与「${this.v2meta?.name ?? '电脑'}」互传文件 / 同步剪贴板 / 截屏（E2E 加密）`)
        .fontSize(12).fontColor(SUB).alignSelf(ItemAlign.Start)

      Column({ space: 8 }) {
        Text('📁').fontSize(30)
        Text('文件互传').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#1A1A1A')
        Text('浏览电脑文件并下载 / 上传手机文件（1GB 兜底）')
          .fontSize(11).fontColor(SUB)
      }
      .width('100%')
      .padding(16)
      .backgroundColor(CARD)
      .borderRadius(12)
      .onClick(() => {
        this.toolPath = '';
        this.toolFiles = [];
        this.toolStatus = '';
        this.view = 'toolsFiles';
        this.loadToolDir('__quick__');
      })

      Column({ space: 8 }) {
        Text('📋').fontSize(30)
        Text('剪贴板').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#1A1A1A')
        Text('手机与电脑之间复制粘贴文本')
          .fontSize(11).fontColor(SUB)
      }
      .width('100%')
      .padding(16)
      .backgroundColor(CARD)
      .borderRadius(12)
      .onClick(() => {
        this.clipText = '';
        this.toolStatus = '';
        this.view = 'toolsClip';
      })

      Column({ space: 8 }) {
        Text('📷').fontSize(30)
        Text('截图').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#1A1A1A')
        Text('截取电脑屏幕并保存到手机查看')
          .fontSize(11).fontColor(SUB)
      }
      .width('100%')
      .padding(16)
      .backgroundColor(CARD)
      .borderRadius(12)
      .onClick(() => {
        this.shotPreview = '';
        this.toolStatus = '';
        this.view = 'toolsShot';
      })

      Column({ space: 8 }) {
        Text('🖥️').fontSize(30)
        Text('窗口实况').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#1A1A1A')
        Text('实时查看电脑窗口画面，点击画面回传点击')
          .fontSize(11).fontColor(SUB)
      }
      .width('100%')
      .padding(16)
      .backgroundColor(CARD)
      .borderRadius(12)
      .onClick(() => {
        this.liveWindows = [];
        this.liveHwnd = '';
        this.liveTitle = '';
        this.liveFrame = '';
        this.liveFrames = 0;
        this.liveW = 0;
        this.liveH = 0;
        this.liveRunning = false;
        this.toolStatus = '';
        this.view = 'toolsLive';
        this.loadLiveWindows();
      })

      Column({ space: 8 }) {
        Text('🔎').fontSize(30)
        Text('资料检索').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#1A1A1A')
        Text('搜索电脑上已索引的文档并查看内容')
          .fontSize(11).fontColor(SUB)
      }
      .width('100%')
      .padding(16)
      .backgroundColor(CARD)
      .borderRadius(12)
      .onClick(() => {
        this.dsQuery = '';
        this.dsResults = [];
        this.dsReadPath = '';
        this.dsReadContent = '';
        this.toolStatus = '';
        this.view = 'toolsData';
        this.dataLoadSources();
      })

      if (this.toolStatus) {
        Text(this.toolStatus).fontSize(12).fontColor(SUB).width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  /** 文件互传子页：目录浏览 + 下载 + 上传 */
  @Builder
  toolFilesView() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => {
          this.view = 'tools';
        })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Column({ space: 2 }) {
          Text('文件互传').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
          Text(this.toolPath === '__quick__' ? '（常用位置）' : (this.toolPath === '__drives__' ? '（选择磁盘）' : this.toolPath))
            .fontSize(10).fontColor('#9AA0B0').maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        // ⬆️ 上一级（2026-10-25）：快捷页禁用；盘符页/盘根 → 回快捷页；否则到父目录
        Button('⬆️').onClick(() => {
          if (this.toolPath === '__quick__') {
            return;
          }
          if (this.toolPath === '__drives__' || /^[a-zA-Z]:\\?$/.test(this.toolPath)) {
            this.loadToolDir('__quick__');
          } else {
            this.loadToolDir(this.parentOf(this.toolPath));
          }
        })
          .height(32)
          .backgroundColor(CARD)
          .fontColor('#1A1A1A')
          .enabled(!this.toolBusy && !this.fileSearchMode && this.toolPath !== '__quick__')
        // 2026-10-25：检索嵌入互传——🔍 切换浏览/检索模式；上传按钮精简为「传电脑」腾位
        Button(this.fileSearchMode ? '📁' : '🔍')
          .onClick(() => {
            this.fileSearchMode = !this.fileSearchMode;
            this.toolStatus = '';
          })
          .height(32)
          .backgroundColor(this.fileSearchMode ? PRIMARY : CARD)
          .fontColor(this.fileSearchMode ? '#FFFFFF' : '#1A1A1A')
        // 新建文件夹（真实目录浏览时可用；建完直接进入，随后「传电脑」即传入此处）
        if (!this.fileSearchMode && this.toolPath !== '' && this.toolPath !== '__quick__' && this.toolPath !== '__drives__') {
          Button('📁+').onClick(() => { this.mkdirName = ''; this.mkdirVisible = true; })
            .height(32)
            .backgroundColor(CARD)
            .fontColor('#1A1A1A')
            .enabled(!this.toolBusy && !this.selMode)
        }
        Button('传电脑')
          .onClick(() => { this.uploadToPc(); })
          .height(32)
          .fontSize(13)
          .backgroundColor(PRIMARY)
          .fontColor('#FFFFFF')
          .enabled(!this.toolBusy)
      }.width('100%')

      // 新建文件夹输入浮层（AlertDialog 无输入框，用内联浮层实现）
      if (this.mkdirVisible) {
        Row({ space: 8 }) {
          TextInput({ text: this.mkdirName, placeholder: '新文件夹名称' })
            .onChange((v: string) => { this.mkdirName = v; })
            .layoutWeight(1)
            .height(40)
          Button('取消').onClick(() => { this.mkdirVisible = false; this.mkdirName = ''; })
            .height(36).backgroundColor(CARD).fontColor('#1A1A1A')
          Button('新建').onClick(() => { this.mkdirHere(); })
            .height(36).backgroundColor(PRIMARY).fontColor('#FFFFFF')
        }.width('100%')
      }

      // 内嵌检索模式：输入行 + 结果列表（复用资料检索的 dsResults/dataSearch）
      if (this.fileSearchMode) {
        Row({ space: 8 }) {
          TextInput({ text: this.dsQuery, placeholder: '搜全电脑文件名，如 交接 报告 ext:pdf' })
            .onChange((v: string) => { this.dsQuery = v; })
            .layoutWeight(1)
            .height(40)
          Button(this.toolBusy ? '搜索中' : '搜索')
            .onClick(() => { this.dataSearch(); })
            .height(40)
            .backgroundColor(PRIMARY)
            .fontColor('#FFFFFF')
            .enabled(!this.toolBusy)
        }.width('100%')

        if (this.toolStatus) {
          Text(this.toolStatus).fontSize(12).fontColor(SUB).width('100%')
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        if (!this.toolBusy && this.dsResults.length === 0 && this.toolStatus === '') {
          Text('输入关键词搜索全电脑索引').fontSize(13).fontColor(SUB).width('100%')
            .textAlign(TextAlign.Center).margin({ top: 24 })
        }
        List({ space: 6 }) {
          ForEach(this.dsResults, (it: DataSearchItem) => {
            ListItem() {
              Column({ space: 4 }) {
                Row({ space: 8 }) {
                  Text('📄').fontSize(16)
                  Text(it.name || it.path)
                    .fontSize(14).fontWeight(FontWeight.Medium).fontColor('#1A1A1A')
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                  Text(this.fmtSize(it.size)).fontSize(11).fontColor('#9AA0B0')
                }.width('100%')
                Text(it.path)
                  .fontSize(10).fontColor('#9AA0B0')
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .width('100%')
              }
              .width('100%')
              .padding(10)
              .backgroundColor(CARD)
              .borderRadius(10)
              .alignItems(HorizontalAlign.Start)
            }
            .onClick(() => { this.dataRead(it, 'toolsFiles'); })
          }, (it: DataSearchItem, idx: number) => `fs/${idx}/${it.path}`)
        }
        .layoutWeight(1)
        .width('100%')
      } else {

      if (this.toolStatus) {
        Text(this.toolStatus).fontSize(12).fontColor(SUB).width('100%')
          .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      if (this.toolBusy && this.toolFiles.length === 0) {
        Text('加载中…').fontSize(13).fontColor(SUB)
      }

      // 批量取回中断续传条（2026-10-26）：App 重启后仍在，点「继续」接着取
      if (this.batchLeft > 0) {
        Row({ space: 8 }) {
          Text(`⏸ 批量取回中断，还剩 ${this.batchLeft} 个文件`)
            .fontSize(12).fontColor('#D48806').layoutWeight(1)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Button('继续')
            .height(28).fontSize(12)
            .backgroundColor(PRIMARY).fontColor('#FFFFFF')
            .enabled(!this.toolBusy)
            .onClick(() => { this.resumeBatch(); })
        }
        .width('100%')
        .padding(8)
        .backgroundColor('#FFF7E6')
        .borderRadius(8)
      }

      List({ space: 6 }) {
        ForEach(this.toolFiles, (it: ToolFileItem) => {
          ListItem() {
            Column() {
              Row({ space: 10 }) {
                if (this.selMode) {
                  Text(this.isSel(it) ? '☑' : '☐').fontSize(18)
                }
                Text(it.quick ? '📂' : (it.dir ? '📁' : '📄')).fontSize(18)
                Text(it.name)
                  .fontSize(14)
                  .fontColor('#1A1A1A')
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                Text(it.dir ? '' : this.fmtSize(it.size))
                  .fontSize(11).fontColor('#9AA0B0')
              }
              .width('100%')
              // 下载进度行：显示在当前下载项的文件名下方（2026-10-26）
              if (this.fullPathOf(it) === this.dlItemPath && this.dlText !== '') {
                Text(this.dlText)
                  .fontSize(12)
                  .fontColor(this.dlResume ? '#D48806' : PRIMARY)
                  .margin({ top: 4, left: 28 })
                  .width('100%')
              }
            }
            .width('100%')
            .padding(10)
            .backgroundColor(this.isSel(it) ? '#E3F0FF' : CARD)
            .borderRadius(10)
            .gesture(
              LongPressGesture().onAction(() => {
                // 长按进入多选（文件夹也可选=整夹传送）
                if (!this.selMode) {
                  this.selMode = true;
                  this.selItems = [];
                }
                this.toggleSel(it);
              })
            )
          }
          .onClick(() => { this.onToolFileTap(it); })
        }, (it: ToolFileItem, idx: number) => `${this.toolPath}/${idx}/${it.name}`)
      }
      .layoutWeight(1)
      .width('100%')

      // 多选操作条（2026-10-25：多选/整夹传送）
      if (this.selMode) {
        Row({ space: 10 }) {
          Text(`已选 ${this.selItems.length} 项`).fontSize(13).fontColor('#1A1A1A').layoutWeight(1)
          Button('取消').onClick(() => { this.selMode = false; this.selItems = []; })
            .height(34).backgroundColor(CARD).fontColor('#1A1A1A')
          Button(`取回 ${this.selItems.length > 0 ? `(${this.selItems.length})` : ''}`)
            .onClick(() => { this.batchDownload(); })
            .height(34).backgroundColor(PRIMARY).fontColor('#FFFFFF')
            .enabled(!this.toolBusy && this.selItems.length > 0)
        }.width('100%')
      }
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  /** 剪贴板子页 */
  @Builder
  toolClipView() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => { this.view = 'tools'; })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Text('剪贴板同步').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
      }.width('100%')

      Button(this.toolBusy ? '取回中…' : '📥 从电脑取')
        .onClick(() => { this.clipFromPc(); })
        .width('100%')
        .height(44)
        .backgroundColor(PRIMARY)
        .fontColor('#FFFFFF')
        .borderRadius(22)
        .enabled(!this.toolBusy)

      Button('📤 发送到电脑')
        .onClick(() => { this.clipToPc(); })
        .width('100%')
        .height(44)
        .backgroundColor(CARD)
        .fontColor('#1A1A1A')
        .borderRadius(22)
        .enabled(!this.toolBusy)

      if (this.clipText) {
        Column({ space: 6 }) {
          Text('内容').fontSize(13).fontColor(SUB).alignSelf(ItemAlign.Start)
          Text(this.clipText)
            .fontSize(13)
            .fontColor('#1A1A1A')
            .width('100%')
            .maxLines(12)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .padding(12)
        .backgroundColor(CARD)
        .borderRadius(12)
        .alignItems(HorizontalAlign.Start)
      }

      if (this.toolStatus) {
        Text(this.toolStatus).fontSize(12).fontColor(SUB).width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  /** 截图子页 */
  @Builder
  toolShotView() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => { this.view = 'tools'; })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Text('电脑截图').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
      }.width('100%')

      Button(this.toolBusy ? '截图中…' : '📷 截取电脑屏幕')
        .onClick(() => { this.takeScreenshot(); })
        .width('100%')
        .height(44)
        .backgroundColor(PRIMARY)
        .fontColor('#FFFFFF')
        .borderRadius(22)
        .enabled(!this.toolBusy)

      Scroll() {
        Column({ space: 8 }) {
          if (this.shotPreview) {
            Image(this.shotPreview)
              .width('100%')
              .objectFit(ImageFit.Contain)
              .borderRadius(12)
              .backgroundColor('#F2F3F7')
            Button(this.toolBusy ? '保存中…' : '💾 保存到下载')
              .onClick(() => { this.saveShotToDownload(); })
              .width('100%')
              .height(40)
              .backgroundColor(CARD)
              .fontColor('#1A1A1A')
              .borderRadius(20)
              .enabled(!this.toolBusy)
          }
          if (this.toolStatus) {
            Text(this.toolStatus).fontSize(12).fontColor(SUB).width('100%')
          }
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  /** 窗口实况子页：窗口选择区 + 实况画面 + 点击回传（M4.5a/M4.5b） */
  @Builder
  toolLiveView() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => {
          this.stopLiveLoop();
          this.view = 'tools';
        })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Text('窗口实况').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
      }.width('100%')

      // 窗口选择区（未选中时展示；窗口多时列表滚动）
      if (this.liveHwnd === '') {
        if (this.liveWindows.length === 0) {
          Text(this.toolStatus || '正在获取窗口列表…').fontSize(12).fontColor(SUB)
        } else {
          Text(`共 ${this.liveWindows.length} 个窗口，选择一个开始实况`)
            .fontSize(12).fontColor(SUB).alignSelf(ItemAlign.Start)
          List({ space: 6 }) {
            ForEach(this.liveWindows, (w: LiveWindowItem) => {
              ListItem() {
                Row({ space: 10 }) {
                  Text(w.minimized ? '🖥️💤' : '🖥️').fontSize(16)
                  Column({ space: 2 }) {
                    Text(w.title || '（无标题窗口）')
                      .fontSize(14)
                      .fontColor('#1A1A1A')
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                    Text(w.minimized ? `${w.w}×${w.h} · 已最小化` : `${w.w}×${w.h}`)
                      .fontSize(11).fontColor(w.minimized ? DANGER : '#9AA0B0')
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)
                }
                .width('100%')
                .padding(10)
                .backgroundColor(CARD)
                .borderRadius(10)
              }
              .onClick(() => { this.pickLiveWindow(w); })
            }, (w: LiveWindowItem) => `${w.hwnd}/${w.title}`)
          }
          .layoutWeight(1)
          .width('100%')
        }
      } else {
        if (!this.liveFullscreen) {
          // 实况状态行
          Row({ space: 8 }) {
            Circle({ width: 8, height: 8 }).fill(this.liveRunning ? '#22C55E' : '#EF4444')
            Text(this.liveRunning ? '实况中' : '已停止')
              .fontSize(12).fontColor(this.liveRunning ? '#22C55E' : DANGER)
            Text(`${this.liveTitle} · ${this.liveFrames}帧 · ${this.liveW}×${this.liveH}`)
              .fontSize(11).fontColor(SUB)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            Button('⛶')
              .onClick(() => { this.toggleLiveFullscreen(true); })
              .height(28).fontSize(12)
              .backgroundColor(PRIMARY).fontColor('#FFFFFF')
            Button('停止实况')
              .onClick(() => {
                this.stopLiveLoop();
                this.toolStatus = '已停止实况';
              })
              .height(28).fontSize(12)
              .backgroundColor(CARD).fontColor(DANGER)
          }.width('100%')
        }

        // 实况画面：点击归一化回传（静止时零流量）；双指捏合缩放 + 拖动查看细节
        Column() {
          if (this.liveFrame) {
            Image(this.liveFrame)
              .width('100%')
              .objectFit(ImageFit.Contain)
              .borderRadius(12)
              .backgroundColor('#F2F3F7')
              .scale({ x: this.liveScale, y: this.liveScale })
              .translate({ x: this.liveTx, y: this.liveTy })
              .gesture(
                GestureGroup(GestureMode.Exclusive,
                  PinchGesture({ fingers: 2 })
                    .onActionStart(() => { this.livePinchStart = this.liveScale; })
                    .onActionUpdate((e: GestureEvent) => {
                      this.liveScale = Math.min(6, Math.max(1, this.livePinchStart * e.scale));
                      if (this.liveScale <= 1) { this.liveTx = 0; this.liveTy = 0; }
                    }),
                  PanGesture({ fingers: 2 })
                    .onActionUpdate((e: GestureEvent) => {
                      if (this.liveScale > 1) {
                        this.liveTx += e.offsetX;
                        this.liveTy += e.offsetY;
                      }
                    })
                )
              )
              .onClick((event: ClickEvent) => {
                // 缩放/拖动后坐标补偿：组件未变换坐标系里的归一化换算
                const aw = Number(event.target.area.width) || 1;
                const ah = Number(event.target.area.height) || 1;
                const nx = ((event.x - this.liveTx) / this.liveScale) / aw;
                const ny = ((event.y - this.liveTy) / this.liveScale) / ah;
                this.onLiveTap(nx, ny);
              })
          } else {
            Text(this.liveRunning ? '正在连接实况…' : '实况已停止')
              .fontSize(13).fontColor(SUB)
              .width('100%').height(200)
              .textAlign(TextAlign.Center)
          }
          if (this.toolStatus && !this.liveFullscreen) {
            Text(this.toolStatus).fontSize(12).fontColor(SUB).width('100%')
              .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          if (this.liveFullscreen) {
            // 全屏时的退出按钮（底部半透明小条，不遮画面）
            Button('✕ 退出全屏')
              .onClick(() => { this.toggleLiveFullscreen(false); })
              .height(30).fontSize(12)
              .backgroundColor('#991A1A1A').fontColor('#FFFFFF')
              .alignSelf(ItemAlign.End)
          }
        }
        .layoutWeight(1)
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  /** 资料检索子页：关键词搜索已索引文档 */
  @Builder
  dataSearchView() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => { this.view = 'tools'; })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Column({ space: 2 }) {
          Text('资料检索').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#1A1A1A')
          Text(this.dsIndexed >= 0 ? `已索引 ${this.dsIndexed} 个文件` : '电脑端文档索引')
            .fontSize(10).fontColor('#9AA0B0')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      }.width('100%')

      Row({ space: 8 }) {
        TextInput({ text: this.dsQuery, placeholder: '输入关键词，如 部署 步骤' })
          .onChange((v: string) => { this.dsQuery = v; })
          .layoutWeight(1)
          .height(40)
        Button(this.toolBusy ? '搜索中' : '搜索')
          .onClick(() => { this.dataSearch(); })
          .height(40)
          .backgroundColor(PRIMARY)
          .fontColor('#FFFFFF')
          .enabled(!this.toolBusy)
      }.width('100%')

      if (this.toolStatus) {
        Text(this.toolStatus).fontSize(12).fontColor(SUB).width('100%')
          .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      if (!this.toolBusy && this.dsResults.length === 0 && this.toolStatus === '') {
        Text('输入关键词开始搜索').fontSize(13).fontColor(SUB).width('100%')
          .textAlign(TextAlign.Center).margin({ top: 24 })
      }

      List({ space: 6 }) {
        ForEach(this.dsResults, (it: DataSearchItem) => {
          ListItem() {
            Column({ space: 4 }) {
              Row({ space: 8 }) {
                Text('📄').fontSize(16)
                Text(it.name || it.path)
                  .fontSize(14).fontWeight(FontWeight.Medium).fontColor('#1A1A1A')
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                Text(this.fmtSize(it.size)).fontSize(11).fontColor('#9AA0B0')
              }.width('100%')
              Text(it.path)
                .fontSize(10).fontColor('#9AA0B0')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .width('100%')
              if (it.hits.length > 0) {
                Text(it.hits.join('\n'))
                  .fontSize(11).fontColor(SUB)
                  .maxLines(4)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .width('100%')
              }
            }
            .width('100%')
            .padding(10)
            .backgroundColor(CARD)
            .borderRadius(10)
            .alignItems(HorizontalAlign.Start)
          }
          .onClick(() => { this.dataRead(it); })
        }, (it: DataSearchItem, idx: number) => `${idx}/${it.path}`)
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  /** 资料检索：文件查看页（2026-10-25 分层预览：html/图片/纯文本） */
  @Builder
  dataReadView() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('‹').onClick(() => {
          this.dsReadPath = '';
          this.dsReadContent = '';
          this.previewHtml = '';
          this.previewPixel = undefined;
          this.previewKind = '';
          this.view = this.dataReadBack;
        })
          .width(36).height(32).backgroundColor(CARD).fontColor('#1A1A1A')
        Text(this.dsReadPath)
          .fontSize(12).fontColor('#1A1A1A')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }.width('100%')

      if (this.previewKind === 'image') {
        Scroll() {
          Column() {
            if (this.previewPixel) {
              Image(this.previewPixel)
                .objectFit(ImageFit.Contain)
                .width('100%')
            }
          }.padding(8)
        }
        .layoutWeight(1)
        .width('100%')
      } else if (this.previewKind === 'html') {
        // md/代码/Office 转换产物：后端已产完整 html（含移动端 viewport 与样式）
        Web({ src: 'about:blank', controller: this.previewCtrl })
          .layoutWeight(1)
          .width('100%')
          .onControllerAttached(() => {
            try {
              this.previewCtrl.loadData(this.previewHtml, 'text/html', 'utf-8');
            } catch (e) {
              hilog.warn(0x0000, TAG, '预览 loadData 失败: %{public}s', String(e));
            }
          })
      } else {
        Scroll() {
          Text(this.dsReadContent === '' ? '（空文件）' : this.dsReadContent)
            .fontSize(13)
            .fontColor('#1A1A1A')
            .width('100%')
            .padding(12)
            .textAlign(TextAlign.Start)
        }
        .layoutWeight(1)
        .width('100%')
        .backgroundColor(CARD)
        .borderRadius(12)
        .align(Alignment.Top)
      }
    }
    .width('100%')
    .height('100%')
    .padding(16)
  }

  build() {
    Column() {
      if (this.view === 'pair') {
        Scroll() { this.pairView() }
      } else if (this.view === 'web') {
        this.webView()
      } else if (this.view === 'devices') {
        this.devicesView()
      } else if (this.view === 'rlpick') {
        this.rlPickView()
      } else if (this.view === 'tools') {
        this.toolsView()
      } else if (this.view === 'toolsFiles') {
        this.toolFilesView()
      } else if (this.view === 'toolsClip') {
        this.toolClipView()
      } else if (this.view === 'toolsShot') {
        this.toolShotView()
      } else if (this.view === 'toolsLive') {
        this.toolLiveView()
      } else if (this.view === 'toolsData') {
        this.dataSearchView()
      } else if (this.view === 'toolsDataRead') {
        this.dataReadView()
      } else if (this.view === 'wait') {
        this.waitView()
      } else {
        this.waitView() // 兜底：未知状态一律落 v2 等待页（v1 settings 视图已随直连模式移除）
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }

  /** v2.1 完整模式：WebView 承载 dsh 完整 GUI（经本地代理 → E2E 隧道 → companion → dsh），
   *  底部叠悬浮状态条（双灯 + 工具按钮），不遮挡 GUI 内容，可收起为状态圆点 */
  @Builder
  webView() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
        if (this.webLoading) {
          Progress({ value: 0, total: 100, type: ProgressType.Linear }).color(PRIMARY).width('100%')
        }
        Web({ src: this.webUrl, controller: this.webCtrl })
          .width('100%')
          .layoutWeight(1)
          .backgroundColor('#FFFFFF')
          .domStorageAccess(true)
          .databaseAccess(true)
          .cacheMode(CacheMode.Default)
          .fileAccess(false)
          .onPageEnd(() => {
            this.webLoading = false;
            hilog.info(0x0000, TAG, 'WebView 页面加载完成');
          })
          .onErrorReceive((event: OnErrorReceiveEvent) => {
            if (event.request.isMainFrame()) {
              hilog.error(0x0000, TAG, 'WebView 主帧错误: %{public}s', event.error.getErrorInfo());
            }
          })
      }
      .width('100%')
      .height('100%')

      this.statusOverlay()
    }
    .width('100%')
    .height('100%')
  }

  /** 悬浮状态条（v2.1 竖版）：左侧中间偏下，上灯=直连(P2P)、下灯=中转(中继隧道)；
   *  直连建立时中转保持原色不变灰；延迟大时已建立的灯绿转橙；
   *  竖排按钮 刷新/扫码/设备；不遮挡 GUI 侧栏与底部输入区，可收起为状态圆点 */
  @Builder
  statusOverlay() {
    if (this.overlayOpen) {
      Column() {
        Row() {
          Circle({ width: 9, height: 9 }).fill(this.pathLightColor(this.directOk))
          Text(this.pathLatencyText(true)).fontSize(8).fontColor('#FFFFFF').margin({ left: 4 })
        }
        .margin({ bottom: 8 })

        Row() {
          Circle({ width: 9, height: 9 }).fill(this.pathLightColor(this.relayOk))
          Text(this.pathLatencyText(false)).fontSize(8).fontColor('#FFFFFF').margin({ left: 4 })
        }
        .margin({ bottom: 12 })

        Text('刷新').fontSize(10).fontColor('#FFFFFF')
          .padding({ top: 5, bottom: 5, left: 2, right: 2 })
          .margin({ bottom: 4 })
          .onClick(() => {
            try {
              this.webCtrl.refresh();
            } catch (e) {
              // controller 未附着时忽略
            }
          })
        Text('配对').fontSize(10).fontColor('#FFFFFF')
          .padding({ top: 5, bottom: 5, left: 2, right: 2 })
          .margin({ bottom: 4 })
          .onClick(() => {
            this.view = 'pair';
          })
        Text('Agent').fontSize(10).fontColor('#FFFFFF')
          .padding({ top: 5, bottom: 5, left: 2, right: 2 })
          .margin({ bottom: 4 })
          .onClick(() => {
            this.openDevices();
          })
        // 通用壳目标选择页（2026-10-24）：/t/ 下挂的 opencode/ZCode/codex 等 target 入口
        // 2026-10-26 应要求移除：目标工具下线，入口删除
        Text('工具').fontSize(10).fontColor('#FFFFFF')
          .padding({ top: 5, bottom: 5, left: 2, right: 2 })
          .margin({ bottom: 8 })
          .onClick(() => {
            this.view = 'tools';
          })
        Text('✕').fontSize(10).fontColor('#FFFFFF99')
          .padding({ top: 3, bottom: 3, left: 2, right: 2 })
          .onClick(() => {
            this.overlayOpen = false;
          })
      }
      .padding(8)
      .backgroundColor('#991A1A1A')
      .borderRadius(14)
      .position({ x: 6, y: '50%' })
    } else {
      Column() {
        Circle({ width: 11, height: 11 }).fill(this.pathLightColor(this.relayOk))
      }
      .padding(7)
      .backgroundColor('#661A1A1A')
      .borderRadius(12)
      .position({ x: 8, y: '50%' })
      .onClick(() => {
        this.overlayOpen = true;
      })
    }
  }
}
