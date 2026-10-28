/**
 * 多设备配对存储：每台设备（一台 PC）的 Cookie/token 用独立别名存 HarmonyOS Asset Store，
 * 设备列表/激活标记存 hh_devices 偏好，标题与工作区缓存按设备隔离。
 * 旧版单设备数据（hh_pair / hh_titles / hh_workspaces）首次读取时自动迁移。
 */
import { common } from '@kit.AbilityKit';
import { asset } from '@kit.AssetStoreKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PairInfo, DeviceMeta, ChatMessage, DeviceMetaV2 } from './Types';

const TAG: string = 'HHStore';

const PREFS_DEVICES: string = 'hh_devices';
const DEV_LIST: string = 'devices';     // JSON 数组：[DeviceMeta]
const DEV_ACTIVE: string = 'active';    // 当前激活设备 id
const PREF_WS_LIST: string = 'paths';
const PREF_FALLBACK: string = 'hh_secrets_fallback'; // Asset Store 拒绝时的降级存储

// 旧版单设备存储（仅迁移用）
const LEGACY_PREFS: string = 'hh_pair';
const LEGACY_TITLES: string = 'hh_titles';
const LEGACY_WS: string = 'hh_workspaces';
const LEGACY_KEY_ALIAS: string = 'harness_api_cookie';
const LEGACY_TOKEN_ALIAS: string = 'harness_launch_token';
const LEGACY_PREF_HOST: string = 'host';
const LEGACY_PREF_PORT: string = 'port';
const LEGACY_PREF_BASE: string = 'basePath';

const ERR_ASSET_EXISTS: number = 24000003;

export class SecureStore {
  private ctx: common.UIAbilityContext;

  constructor(ctx: common.UIAbilityContext) {
    this.ctx = ctx;
  }

  // ---------------- Asset Store（密钥级） ----------------

  private aliasBytes(alias: string): Uint8Array {
    const textEncoder = new util.TextEncoder('utf-8');
    return textEncoder.encodeInto(alias);
  }

  private buildAssetMap(alias: string, secret: Uint8Array): asset.AssetMap {
    const m: asset.AssetMap = new Map();
    m.set(asset.Tag.ALIAS, this.aliasBytes(alias));
    m.set(asset.Tag.SECRET, secret);
    m.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
    m.set(asset.Tag.AUTH_TYPE, asset.AuthType.NONE);
    m.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER);
    return m;
  }

  private aliasQuery(alias: string): asset.AssetMap {
    const q: asset.AssetMap = new Map();
    q.set(asset.Tag.ALIAS, this.aliasBytes(alias));
    return q;
  }

  /** 写入安全字段：优先 Asset Store；实测部分机型/状态会稳定拒绝（401 参数错误），
   *  3 次重试无效则降级到本地偏好存储（fallback），保证配对流程不中断。 */
  private writeSecret(alias: string, value: string): void {
    const textEncoder = new util.TextEncoder('utf-8');
    const secretBytes: Uint8Array = textEncoder.encodeInto(value);
    let lastErr: string = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        asset.addSync(this.buildAssetMap(alias, secretBytes));
        if (attempt > 1) {
          hilog.info(0x0000, TAG, 'asset add 第 %{public}d 次重试成功 %{public}s', attempt, alias);
        }
        // 成功后清掉可能存在的降级副本，避免读到旧值
        this.removeFallback(alias);
        return;
      } catch (e) {
        lastErr = `${(e as BusinessError).code ?? 0}`;
        // 无论什么码，先删除旧条目再重试
        try { asset.removeSync(this.aliasQuery(alias)); } catch (e2) { /* 忽略 */ }
        if (attempt < 3) {
          const t0 = Date.now();
          while (Date.now() - t0 < 150 * attempt) { /* 短延迟 */ }
        }
      }
    }
    // 降级：本地偏好存储（本机 personal 工具，可接受；不影响配对流程）
    hilog.warn(0x0000, TAG, 'asset add 连续失败(%{public}s)，降级到本地偏好存储 %{public}s', lastErr, alias);
    const prefs = preferences.getPreferencesSync(this.ctx, { name: PREF_FALLBACK });
    prefs.putSync(alias, value);
    prefs.flushSync();
  }

  private fallbackPrefs(): preferences.Preferences {
    return preferences.getPreferencesSync(this.ctx, { name: PREF_FALLBACK });
  }

  private removeFallback(alias: string): void {
    try {
      const prefs = this.fallbackPrefs();
      if (prefs.getSync(alias, '') as string !== '') {
        prefs.deleteSync(alias);
        prefs.flushSync();
      }
    } catch (e) { /* 忽略 */ }
  }

  private readSecret(alias: string): string {
    try {
      const q: asset.AssetMap = this.aliasQuery(alias);
      q.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      const rows: Array<asset.AssetMap> = asset.querySync(q);
      if (rows.length > 0) {
        const secret: Uint8Array = rows[0].get(asset.Tag.SECRET) as Uint8Array;
        const textDecoder = util.TextDecoder.create('utf-8');
        return textDecoder.decodeToString(secret);
      }
    } catch (e) {
      // 忽略，转降级存储
    }
    // Asset Store 没有 → 查降级存储
    try {
      return this.fallbackPrefs().getSync(alias, '') as string;
    } catch (e) {
      return '';
    }
  }

  private removeSecret(alias: string): void {
    try {
      asset.removeSync(this.aliasQuery(alias));
    } catch (e) {
      // 不存在则忽略
    }
    this.removeFallback(alias);
  }

  private cookieAlias(deviceId: string): string {
    return `harness_api_cookie.${deviceId}`;
  }

  private tokenAlias(deviceId: string): string {
    return `harness_launch_token.${deviceId}`;
  }

  // ---------------- 设备列表 ----------------

  /** 全部已配对设备；首次调用自动迁移旧版单设备数据 */
  async listDevices(): Promise<Array<DeviceMeta>> {
    const prefs = preferences.getPreferencesSync(this.ctx, { name: PREFS_DEVICES });
    const raw: string = prefs.getSync(DEV_LIST, '') as string;
    if (raw) {
      try {
        return JSON.parse(raw) as Array<DeviceMeta>;
      } catch (e) {
        return [];
      }
    }
    return this.migrateLegacy(prefs);
  }

  /** 当前激活设备 id（无记录返回 ''） */
  async activeDeviceId(): Promise<string> {
    const prefs = preferences.getPreferencesSync(this.ctx, { name: PREFS_DEVICES });
    return prefs.getSync(DEV_ACTIVE, '') as string;
  }

  async setActiveDevice(id: string): Promise<void> {
    const prefs = preferences.getPreferencesSync(this.ctx, { name: PREFS_DEVICES });
    prefs.putSync(DEV_ACTIVE, id);
    await prefs.flush();
  }

  /** 新增或更新设备元信息（按 id upsert） */
  async saveDevice(meta: DeviceMeta): Promise<void> {
    const prefs = preferences.getPreferencesSync(this.ctx, { name: PREFS_DEVICES });
    let list: Array<DeviceMeta> = [];
    const raw: string = prefs.getSync(DEV_LIST, '') as string;
    if (raw) {
      try {
        list = JSON.parse(raw) as Array<DeviceMeta>;
      } catch (e) {
        list = [];
      }
    }
    const next: Array<DeviceMeta> = [];
    let found: boolean = false;
    list.forEach((d: DeviceMeta) => {
      if (d.id === meta.id) {
        next.push(meta);
        found = true;
      } else {
        next.push(d);
      }
    });
    if (!found) {
      next.push(meta);
    }
    prefs.putSync(DEV_LIST, JSON.stringify(next));
    await prefs.flush();
  }

  /** 删除设备：清密钥、标题缓存、工作区缓存，并从列表移除 */
  async removeDevice(id: string): Promise<void> {
    this.removeSecret(this.cookieAlias(id));
    this.removeSecret(this.tokenAlias(id));
    const titles = preferences.getPreferencesSync(this.ctx, { name: this.titlesName(id) });
    await titles.clear();
    await titles.flush();
    const ws = preferences.getPreferencesSync(this.ctx, { name: this.wsName(id) });
    await ws.clear();
    await ws.flush();
    const prefs = preferences.getPreferencesSync(this.ctx, { name: PREFS_DEVICES });
    let list: Array<DeviceMeta> = [];
    const raw: string = prefs.getSync(DEV_LIST, '') as string;
    if (raw) {
      try {
        list = JSON.parse(raw) as Array<DeviceMeta>;
      } catch (e) {
        list = [];
      }
    }
    const next: Array<DeviceMeta> = list.filter((d: DeviceMeta) => d.id !== id);
    prefs.putSync(DEV_LIST, JSON.stringify(next));
    const active: string = prefs.getSync(DEV_ACTIVE, '') as string;
    if (active === id) {
      prefs.putSync(DEV_ACTIVE, next.length > 0 ? next[0].id : '');
    }
    await prefs.flush();
  }

  // ---------------- 配对信息（按设备） ----------------

  /** 保存配对密钥：Cookie/token 进 asset store */
  async savePair(info: PairInfo, deviceId: string): Promise<void> {
    this.writeSecret(this.cookieAlias(deviceId), info.cookie);
    this.writeSecret(this.tokenAlias(deviceId), info.token);
  }

  /** 读取某设备的配对信息；元信息缺失或密钥不存在返回 null */
  async loadPair(deviceId: string): Promise<PairInfo | null> {
    const list: Array<DeviceMeta> = await this.listDevices();
    let meta: DeviceMeta | undefined;
    list.forEach((d: DeviceMeta) => {
      if (d.id === deviceId) {
        meta = d;
      }
    });
    if (!meta) {
      return null;
    }
    const m: DeviceMeta = meta as DeviceMeta;
    const cookie: string = this.readSecret(this.cookieAlias(deviceId));
    if (!cookie) {
      return null;
    }
    const token: string = this.readSecret(this.tokenAlias(deviceId));
    return { host: m.host, port: m.port, basePath: m.basePath, cookie: cookie, token: token };
  }

  /** 只更新 Cookie（WS 断开自动重铸后用） */
  async updateCookie(deviceId: string, cookie: string): Promise<void> {
    this.writeSecret(this.cookieAlias(deviceId), cookie);
  }

  // ---------------- 会话标题缓存（按设备） ----------------

  private titlesName(deviceId: string): string {
    return `hh_titles.${deviceId}`;
  }

  async loadTitles(deviceId: string): Promise<Record<string, string>> {
    const titles = preferences.getPreferencesSync(this.ctx, { name: this.titlesName(deviceId) });
    const raw: Object = await titles.getAll();
    return raw as Record<string, string>;
  }

  async saveTitle(deviceId: string, sessionId: string, title: string): Promise<void> {
    if (!sessionId || !title) {
      return;
    }
    const titles = preferences.getPreferencesSync(this.ctx, { name: this.titlesName(deviceId) });
    const old: string = titles.getSync(sessionId, '') as string;
    if (old === title) {
      return;
    }
    titles.putSync(sessionId, title);
    await titles.flush();
  }

  /** 删除标题缓存（清理历史遗留的脏标题用） */
  async deleteTitle(deviceId: string, sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    try {
      const titles = preferences.getPreferencesSync(this.ctx, { name: this.titlesName(deviceId) });
      titles.deleteSync(sessionId);
      await titles.flush();
    } catch (e) {
      // 清理失败不影响主流程
    }
  }

  // ---------------- 会话消息缓存（按设备，进会话秒开） ----------------

  private msgsName(deviceId: string): string {
    return `hh_msgs.${deviceId}`;
  }

  async loadMessages(deviceId: string, sessionId: string): Promise<Array<ChatMessage>> {
    try {
      const msgs = preferences.getPreferencesSync(this.ctx, { name: this.msgsName(deviceId) });
      const raw: string = msgs.getSync(sessionId, '') as string;
      if (!raw) {
        return [];
      }
      return JSON.parse(raw) as Array<ChatMessage>;
    } catch (e) {
      return [];
    }
  }

  async saveMessages(deviceId: string, sessionId: string, messages: Array<ChatMessage>): Promise<void> {
    if (!sessionId) {
      return;
    }
    try {
      const msgs = preferences.getPreferencesSync(this.ctx, { name: this.msgsName(deviceId) });
      // 只留最近 200 条，避免 preferences 无限膨胀
      const capped = messages.length > 200 ? messages.slice(messages.length - 200) : messages;
      msgs.putSync(sessionId, JSON.stringify(capped));
      await msgs.flush();
    } catch (e) {
      // 缓存失败不影响主流程
    }
  }

  // ---------------- 工作区缓存（按设备） ----------------

  private wsName(deviceId: string): string {
    return `hh_workspaces.${deviceId}`;
  }

  async loadWorkspaces(deviceId: string): Promise<Array<string>> {
    const ws = preferences.getPreferencesSync(this.ctx, { name: this.wsName(deviceId) });
    const raw: string = ws.getSync(PREF_WS_LIST, '[]') as string;
    try {
      const arr: Array<string> = JSON.parse(raw) as Array<string>;
      return arr;
    } catch (e) {
      return [];
    }
  }

  async saveWorkspaces(deviceId: string, paths: Array<string>): Promise<void> {
    const ws = preferences.getPreferencesSync(this.ctx, { name: this.wsName(deviceId) });
    ws.putSync(PREF_WS_LIST, JSON.stringify(paths));
    await ws.flush();
  }

  // ---------------- v2 中继（设备元信息/凭证/身份密钥） ----------------

  private v2Prefs(): preferences.Preferences {
    return preferences.getPreferencesSync(this.ctx, { name: 'hh_v2' });
  }

  async saveV2IdentityPk(pk: string): Promise<void> {
    this.writeSecret('v2_identity_pk', pk);
  }

  async getV2IdentityPk(): Promise<string> {
    return this.readSecret('v2_identity_pk');
  }

  async saveV2Credential(id: string, cred: string): Promise<void> {
    this.writeSecret(`v2_credential.${id}`, cred);
  }

  async getV2Credential(id: string): Promise<string> {
    return this.readSecret(`v2_credential.${id}`);
  }

  async saveV2Meta(meta: DeviceMetaV2): Promise<void> {
    const prefs = this.v2Prefs();
    const list: Array<DeviceMetaV2> = await this.listV2Meta();
    const next: Array<DeviceMetaV2> = list.filter((m: DeviceMetaV2) => m.id !== meta.id);
    next.push(meta);
    prefs.putSync('metas', JSON.stringify(next));
    await prefs.flush();
  }

  async listV2Meta(): Promise<Array<DeviceMetaV2>> {
    try {
      const raw: string = this.v2Prefs().getSync('metas', '[]') as string;
      return JSON.parse(raw) as Array<DeviceMetaV2>;
    } catch (e) {
      return [];
    }
  }

  async setV2Active(id: string): Promise<void> {
    const prefs = this.v2Prefs();
    prefs.putSync('active', id);
    await prefs.flush();
  }

  async getV2Active(): Promise<string> {
    try {
      return this.v2Prefs().getSync('active', '') as string;
    } catch (e) {
      return '';
    }
  }

  async removeV2(id: string): Promise<void> {
    this.removeSecret(`v2_credential.${id}`);
    const prefs = this.v2Prefs();
    const list: Array<DeviceMetaV2> = await this.listV2Meta();
    prefs.putSync('metas', JSON.stringify(list.filter((m: DeviceMetaV2) => m.id !== id)));
    const active: string = prefs.getSync('active', '') as string;
    if (active === id) {
      prefs.putSync('active', '');
    }
    await prefs.flush();
  }

  // ---------------- 旧版迁移 ----------------

  /** 把 v1 单设备数据迁移为多设备列表的第一台设备 */
  private async migrateLegacy(prefs: preferences.Preferences): Promise<Array<DeviceMeta>> {
    const legacy = preferences.getPreferencesSync(this.ctx, { name: LEGACY_PREFS });
    const host: string = legacy.getSync(LEGACY_PREF_HOST, '') as string;
    const port: number = legacy.getSync(LEGACY_PREF_PORT, 0) as number;
    if (!host || !port) {
      return [];
    }
    const cookie: string = this.readSecret(LEGACY_KEY_ALIAS);
    if (!cookie) {
      await legacy.clear();
      await legacy.flush();
      return [];
    }
    const id: string = `dev_${util.generateRandomUUID()}`;
    this.writeSecret(this.cookieAlias(id), cookie);
    const token: string = this.readSecret(LEGACY_TOKEN_ALIAS);
    if (token) {
      this.writeSecret(this.tokenAlias(id), token);
    }
    const meta: DeviceMeta = {
      id: id,
      name: host,
      host: host,
      port: port,
      basePath: legacy.getSync(LEGACY_PREF_BASE, '') as string,
    };
    prefs.putSync(DEV_LIST, JSON.stringify([meta]));
    prefs.putSync(DEV_ACTIVE, id);
    await prefs.flush();
    await this.copyPrefs(LEGACY_TITLES, this.titlesName(id));
    await this.copyPrefs(LEGACY_WS, this.wsName(id));
    await legacy.clear();
    await legacy.flush();
    return [meta];
  }

  /** 逐键复制一个 preferences 文件（旧缓存迁移用） */
  private async copyPrefs(fromName: string, toName: string): Promise<void> {
    const from = preferences.getPreferencesSync(this.ctx, { name: fromName });
    const to = preferences.getPreferencesSync(this.ctx, { name: toName });
    const raw: Object = await from.getAll();
    const all: Record<string, Object> = raw as Record<string, Object>;
    Object.keys(all).forEach((k: string) => {
      to.putSync(k, all[k] as preferences.ValueType);
    });
    await to.flush();
    await from.clear();
    await from.flush();
  }
}
