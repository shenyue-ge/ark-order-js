// 协会/家具/建筑/派遣（重构自 start.js）
const { S, saveState } = require('../state');
const L = require('../lib');
const { log, defaultFill, pushAssetChange, pushServantChanges, pushGoodsUpdate, CHANGE_ID_EXP, CHANGE_ID_LEVEL, CHANGE_ID_STATUS, TRAIN, roleId } = L; // 解构导入，域内裸调用与单文件时代一致
const { advanceMissions } = require('./activity');
// 协会点 = role_scores[4]（GameConst.SCORE_ASS_POINT=4；新版客户端同名 SCORE_DORM=4）——
// 客户端 DormRestPopupPanel / DormFurnitureMakeItem 都读 GlobalData.getScore(4)，
// BagMgr.getItemNum(31000009) 也返回同一个积分（详见 handlers/moment.js 的 score_items 说明）。
const SCORE_ASS_POINT = 4;
// CfgDorm.restNeed（客户端配置原文）：第 n 项 = 解锁第 n 个休息位所需的协会点
const REST_NEED = [0, 0, 100, 125, 150, 175];
// 建筑等级上限：**按 CfgDorm.study 每个建筑的 effect 行数**，不能再写常量。
// ⚠️ bd=3（使命必达/派遣室）的 effect 只有 5 行、level[]/cost[] 也只有 5 项；旧代码用常量 10，
//    升到 Lv6 后客户端 DormDispatchPanel.onGUI 读 effect[6][2] / DormStudyItem.update 读 effect[6][1]
//    直接 index nil 崩面板。这里按建筑分别取（bd=1/2 各 10 行、bd=3 5 行、bd=4 11 行且不可手动升）。
const BUILDING_MAX_LEVEL = { 1: 10, 2: 10, 3: 5, 4: 11 };
function buildingMaxLevel(bdId) { return BUILDING_MAX_LEVEL[bdId] || 10; }
// 派遣任务表 + 派遣室档位（tools/bc_cmp/gen_dispatch_data.js 自客户端 CfgDorm.dispatchs /
// CfgDorm.study[3] 生成）：TASKS[id]={name,tab,type,time,conds[],rewards[[t,min,max]]}，
// BUILDING={cap[5],lvReq[5],lvCost[5],maxLevel:5}
const DISP = require('../data/dispatch_data');
const FC = require('../data/fight_core');   // natureOf（与客户端 Util.indexNum(typeId,4,4) 同口径）
const HB = require('../data/handbook_data'); // DIALOGUE（派遣语音 AUDIO_DISPATCHER=24 的存在性判定）
const FEELR = require('../data/feeling_rules'); // STATUS_DORM_REST（休息位 status 位）等共享口径
// 结果面板第 1 张誓灵卡会播派遣语音（HandbookConst.AUDIO_DISPATCHER=24）。客户端直接
// `HandbookConfig.getServantDialogue(type)[24].text`，缺这段台词的誓灵排第一会 index nil 崩。
function hasDispatchVoice(servantId) {
  const b = S.servants.find(s => Number(s.id) === Number(servantId));
  if (!b) return false;
  const d = HB.DIALOGUE[String(b.type)];
  return Array.isArray(d) && d.includes(24);
}

// ---- 派遣室（bd=3）队列上限与派遣校验 ----
// 客户端上限 = CfgDorm.study[3].effect[DormMgr.dispatchLevel][2]（1/2/3/4/4）。
// 服务端必须自己按同一张表校验：客户端只拿 dispatchNum 拦 UI，不校验就等于"上限只在外包给 UI"。
function dispatchCap() {
  const lv = Math.min(Math.max(dormBuildingLv(3), 1), DISP.BUILDING.cap.length);
  return DISP.BUILDING.cap[lv - 1];
}
// 派遣详情下发（打开面板 / 派遣后 / 取消后 / 领奖后都要发：客户端只靠它 resync dispatchNum）
// 自律派遣（101）的卡片是否下发：客户端 tab6 的解锁门是 `tabsUnlockConditions[6] = 通关主线 3-4`，
// 服务端按同一判据（3-4 的 BOSS 点在 cleared 里）。**101 与 m_copy_auto_* 8 条 handler 必须同批上线**：
// 只发 101 不实现协议 → 卡片可点、点"派遣"毫无反应；只实现协议不发 101 → 客户端
// `DormMgr.getDispatchVO(101)` 为 nil，info_toc 灌不进卡片（卡片空白 + 剩余自律队列恒 0）。
function autoDispatchUnlocked() {
  try {
    const CFG = require('../data/map_configs').MAP_CONFIGS[1030400];
    if (!CFG || !CFG.bossPoint) return false;
    const prog = L.progressOf(1030400) || {};
    return (prog.cleared || []).map(Number).includes(Number(CFG.bossPoint));
  } catch (e) { return false; }
}
function sendCrusadeDetail(conn, bdId) {
  const list = DISP.NORMAL_IDS.slice();
  if (autoDispatchUnlocked()) list.push(require('../data/auto_dispatch_data').AUTO_ID);
  conn.sendToc('m_building_crusade_detail_toc', {
    bd_id: bdId || 3,
    level: dormBuildingLv(3),
    troops: Array.isArray(S.dormState.troops) ? S.dormState.troops : [],
    crusade_list: list,
    extra_reward: [],
  });
}
// 派遣条件校验（DormDispatchVO.checkCondition 的服务端对应实现）
// conds[].kind：1=等级（val=门槛, count=需要几只）/ 2=属性（val=nature, count）/ 3=体力（val=消耗量）
// 返回 null=通过，否则官方错误码（CfgErrorCode 206007 等级 / 206008 属性 / 206009 体力）
function checkDispatchConds(task, bs) {
  for (const c of task.conds || []) {
    if (c.kind === 1) {
      const need = c.count || 1;
      if (bs.filter(b => (Number(b.level) || 1) >= c.val).length < need) return 206007;
    } else if (c.kind === 2) {
      const need = c.count || 1;
      if (bs.filter(b => FC.natureOf(Number(b.type)) === Number(c.val)).length < need) return 206008;
    } else if (c.kind === 3) {
      if (require('./vit').getVit() < Number(c.val)) return 206009;
    }
  }
  return null;
}
function dispatchVitCost(task) {
  const c = (task.conds || []).find(x => x.kind === 3);
  return c ? Number(c.val) || 0 : 0;
}
// ---- 状态位运行期自愈（本条：206001「有誓灵已在派遣或编队中」误拒的根治口）----
// status 位 4（派遣）/ 8（战斗）各有唯一真相源，位与真相源不符 = 过期残留，就地清除后放行：
//   位 4 ↔ dormState.troops（派遣队在册）；位 8 ↔ 存活 locked 会话的名册（battleRosterOf：
//   init_barrier 置位时登记的 battleBitIds ∪ 出战队伍当前 field∪bench）。
// 为什么必须在消费口自愈：loadState 的同款自愈只在**服务重启**时跑一次；运行期任何漏释放
// （关卡中编队换人后再释放/会话被新出击整体覆盖/杀进程）都会让位残留到下次重启为止，
// 玩家被 206001 无限期拒绝且客户端毫无提示（2026-10-31 实锤：位 8 残留 6 只 + 休息位误拒 5 连）。
// 返回：自愈后仍真实占用的 id 列表（供调用方继续走 206001 拒绝）。
function healBusyBits(conn, ids) {
  const troopIds = new Set();
  for (const t of (S.dormState.troops || [])) for (const x of (t.servant_ids || [])) troopIds.add(Number(x));
  let live = [];
  if (S.mapState && S.mapState.locked) {
    try { live = require('./servant').battleRosterOf(S.mapState); } catch (e) { live = []; }
  }
  const liveSet = new Set(live.map(Number));
  const healed = [], busy = [];
  for (const id of ids) {
    const b = S.servants.find(x => Number(x.id) === Number(id));
    if (!b) continue;
    const cur = Number(b.status) || 0;
    let want = cur;
    if ((cur & 4) && !troopIds.has(Number(id))) want &= ~4;
    if ((cur & 8) && !liveSet.has(Number(id))) want &= ~8;
    if (want !== cur) { b.status = want; healed.push({ servant_id: b.id, key: CHANGE_ID_STATUS, val: want }); }
    if ((want & 12) !== 0) busy.push(b.id);
  }
  if (healed.length) {
    saveState();
    pushServantChanges(conn, healed);
    log(`[dorm] 状态位自愈：${healed.map(h => h.servant_id).join(',')}（位与真相源不符已清；troops=${(S.dormState.troops || []).length} 队 locked会话=${S.mapState && S.mapState.locked ? 1 : 0}）`);
  }
  return busy;
}
// 家具制造/购买价目 + 元数据（tools/bc_cmp/gen_dorm_furniture.js 自客户端 CfgDorm.formula /
// CfgHouseFurniture 生成）：FORMULA[id]={point,money}，FURNITURE[id]={name,kind,maxNum,point}
const FUR = require('../data/dorm_furniture_data');

// 某家具当前已摆放数量（S.dormState.furnitures 里的件数）
function placedCountOf(typeId) {
  let n = 0;
  for (const f of S.dormState.furnitures) if (f.type_id === typeId) n++;
  return n;
}
// 繁荣度 = Σ 已摆放家具的 CfgHouseFurniture.point（客户端 prosperity 读 detail 字段，
// 而家具列表包会触发它本地重算：p_kvt.type=已摆放数 × getFurniturePoint —— 两侧保持同口径）
function furnitureProsperity() {
  let sum = 0;
  for (const f of S.dormState.furnitures) sum += (FUR.FURNITURE[f.type_id] || {}).point || 0;
  return sum;
}
// 家具列表 content（p_kvt：id=typeID val=仓库数量 type=已摆放数量）。
// 客户端 DormMgr 以 id 为键合并；拥有数显示 = val + 场景摆放数；编辑器把 val==0 的条目排最后
//（官方兼容形态，因此"仅摆放未囤货"的类型也要带 val=0 条目，繁荣度才完整）
function warehouseContent() {
  const ids = new Set(S.dormState.furnitures.map(f => f.type_id));
  for (const tid of Object.keys(S.dormState.warehouse)) {
    if (Number(S.dormState.warehouse[tid]) > 0) ids.add(Number(tid));
  }
  return [...ids].sort((a, b) => a - b).map(id => ({
    id, val: S.dormState.warehouse[id] || 0, type: placedCountOf(id),
  }));
}
// ---- 摆设编辑快照（协会清单 D-3，2026-11-07）----
// rearrange/reset 是编辑期**即时写盘**（每次拖动都落 S），而客户端"取消"（退出编辑弹窗左键
// MainPanel.lua:124 → m_dorm_save_tos(SAVE_TYPE_CANCEL=0)，文案「当前有未保存的操作，要保存并退出吗」）
// 的 m_dorm_save_toc op=0 分支只 updateFurnitures（服务端回什么画什么），不自带回滚
// ⇒ 服务端必须自己存"编辑前快照"，取消时还原，否则取消=白取消（每次拖动都成永久）。
// 生命周期：首个编辑动作（rearrange/reset）无快照则建；保存(op=1)/套用方案(op=2)/切方案 = 提交清快照；
// 取消(op=0) = 还原 + 清。会话中断残留的快照保留到下一次提交/取消（还原点仍是"最初未编辑态"，更保守）。
function dormEditSnapshot() {
  return {
    furnitures: cloneFurnitures(S.dormState.furnitures),
    warehouse: Object.assign({}, S.dormState.warehouse),
    nextFurId: S.dormState.nextFurId,
  };
}
function dormEditBegin() {
  if (!S.dormState.editBackup) S.dormState.editBackup = dormEditSnapshot();
}
// 扣水晶：先扣赠送（gold_given）再扣充值（gold）——与商店/结社创建同口径
function costCrystal(cost) {
  const useGiven = Math.min(Number(S.roleAsset.gold_given) || 0, cost);
  S.roleAsset.gold_given -= useGiven;
  S.roleAsset.gold -= cost - useGiven;
}
// 可安全入仓库的家具白名单判定（与真机 CfgHouseFurniture + 出货/基座资源对账）：
//   · 排除系统预摆建筑（kind 6派遣中心/7研究所/9体力产出/10金币产出/12补给贩卖机）与
//     扩建施工占位牌（kind 11：100001~100004，maxNum=0、无 icon、点击直接触发扩建）；
//     注意客户端 DormMgr.getFurnituresList 只过滤 THEME_KIND={6,7,9,10}，漏了 11/12，
//     发进仓库会在编辑器家具栏露出无图条目甚至被重复摆出。
//   · 排除官方无资源卫星件 200020（「音游家具」：PackOut/Alpha/KR 全缺 icon 与 spine）。
//   · 保留 200021(hololive)/200022(Mea的柏青哥)/200024(小舟酱电子挂画)/30025(圣诞壁炉 maxNum=0)：
//     美术资源完整，可作摆设；其余全部 295 种（墙纸/地板/路面/墙饰/室内/室外/互动/定制/魔偶）安全。
const NON_GRANTABLE_FURNITURE_KINDS = new Set([6, 7, 9, 10, 11, 12]);
const UNOBTAINABLE_FURNITURE_IDS = new Set([200020]);
function isGrantableFurniture(typeId) {
  const id = Number(typeId);
  const meta = FUR.FURNITURE[id];
  if (!meta) return false;
  if (NON_GRANTABLE_FURNITURE_KINDS.has(Number(meta.kind))) return false;
  if (UNOBTAINABLE_FURNITURE_IDS.has(id)) return false;
  return true;
}
const ALL_GRANTABLE_FURNITURE_IDS = Object.keys(FUR.FURNITURE)
  .map(Number)
  .filter(id => isGrantableFurniture(id))
  .sort((a, b) => a - b);

// 若玩家当前正处于摆设编辑模式（S.dormState.editBackup 非空），GM 发进仓库的增量同步补入
// 撤销基线——否则退出编辑点「取消」（m_dorm_save_tos op=0）会把刚发的家具整包回滚蒸发。
function syncEditBackupWarehouseDelta(typeId, delta) {
  const bak = S.dormState && S.dormState.editBackup;
  if (!bak || !bak.warehouse || !(delta > 0)) return;
  bak.warehouse[typeId] = (Number(bak.warehouse[typeId]) || 0) + delta;
}

// 批量发放家具入仓库（GM 一键全家具用）：整批只落盘 1 次 + 合并推 1 条 m_furnitures_update_toc
// （避免逐件 grantFurniture 在 Android 外存触发百次 fsync 造成 [stall]/13s 超时）。
//   entries: Array<[typeId, num]>
//   opts.capByMaxNum: true 时按 CfgHouseFurniture.maxNum 钳制拥有上限（owned = 仓库 + 已摆放；
//     maxNum=0 如 30025「圣诞壁炉」按官方语义视作无上限，直接 +num）。
function grantFurnitureBatch(conn, entries, opts) {
  const cap = !!(opts && opts.capByMaxNum);
  if (!S.dormState) S.dormState = {};
  if (!S.dormState.warehouse) S.dormState.warehouse = {};
  if (!Array.isArray(S.dormState.furnitures)) S.dormState.furnitures = [];
  const placedMap = new Map();
  for (const f of S.dormState.furnitures) {
    const tid = Number(f.type_id);
    placedMap.set(tid, (placedMap.get(tid) || 0) + 1);
  }
  const touched = new Map();
  let addedItems = 0, addedKinds = 0, cappedKinds = 0, skippedKinds = 0;
  for (const pair of (entries || [])) {
    const typeId = Number(pair && pair[0]);
    const want = Math.floor(Number(pair && pair[1]));
    if (!isGrantableFurniture(typeId) || !Number.isFinite(want) || want <= 0) {
      skippedKinds++;
      continue;
    }
    const meta = FUR.FURNITURE[typeId];
    const curStock = Number(S.dormState.warehouse[typeId]) || 0;
    const placed = placedMap.get(typeId) || 0;
    let add = want;
    if (cap && meta.maxNum > 0) {
      const room = Math.max(0, meta.maxNum - (curStock + placed));
      add = Math.min(want, room);
      if (add <= 0) { cappedKinds++; continue; }
    }
    S.dormState.warehouse[typeId] = curStock + add;
    syncEditBackupWarehouseDelta(typeId, add);
    addedItems += add;
    if (!touched.has(typeId)) addedKinds++;
    touched.set(typeId, { id: typeId, val: S.dormState.warehouse[typeId], type: placed });
  }
  const content = [...touched.values()];
  if (content.length) {
    saveState();
    if (conn && typeof conn.sendToc === 'function') {
      conn.sendToc('m_furnitures_update_toc', { content });
    }
  }
  return { addedItems, addedKinds, cappedKinds, skippedKinds, totalKinds: (entries || []).length, content };
}

// 发放单件家具入仓库（GM 单件指定发放 / 冒烟用），推 m_furnitures_update_toc 增量刷新
function grantFurniture(conn, typeId, num) {
  const id = Number(typeId);
  const n = Math.floor(Number(num));
  if (!isGrantableFurniture(id) || !Number.isFinite(n) || n <= 0) return false;
  S.dormState.warehouse[id] = (S.dormState.warehouse[id] || 0) + n;
  syncEditBackupWarehouseDelta(id, n);
  saveState();
  if (conn && typeof conn.sendToc === 'function') {
    conn.sendToc('m_furnitures_update_toc', {
      content: [{ id, val: S.dormState.warehouse[id], type: placedCountOf(id) }],
    });
  }
  return true;
}

// 入住誓灵 → p_dorm_servant 形状（detail/in_toc 共用）
// 协会初始摆设：坐标/选型照抄客户端大厅布局 HouseUitl.getLobbyFur（同一套 pos 编码
// (dir<<12)+(x<<6)+y），去掉配置里不存在的 20008；补派遣中心(60000)/研究所(70000)两个
// 室外建筑（建筑也是家具，kind=6/7，CfgHouseFurniture [60000]/[70000]）——
// 协会地图 detail 模式的家具 100% 来自 m_dorm_detail_toc.furnitures，不初始摆好地图就是空的
// 二百八十三补售货机两台：90000（kind=12，补给贩卖机本体，canAdd=false 造不出来、
// 只能预摆）/ 90001（kind=10，领取金币，bd2 产出的场景收集位——MainDormAppIcon 的场景侧
// 对应物）。HouseFurnitureVO.getURL 对 kind 6/7/9/10/12 从主题配置取贴图
// （CfgHouseAround_* 的 fur_send/fur_study/fur_vit/fur_gold），HouseScene.updateTheme
// 也会对 kind 9/10/12 逐台换肤 ⇒ 不下发 = 协会里没有这两台机器。
// 摆位 (2,14)/(12,14)：室外可摆区（OUTSIDE_LIMIT_POS 15×16）内、与 60000(5,13)/70000(10,13)
// 错开；canOccupy=false 不占格，玩家可在编辑模式随意拖动。
function defaultDormFurnitures() {
  const P = (x, y, dir) => ((dir || 0) << 12) + (x << 6) + y;
  const layout = [
    [20006, P(12, 0, 1)],   // 远音地板
    [20007, P(9, 10, 1)],   // 棋盘地板
    [20004, P(3, 0, 1)],    // 沙行宫地板
    [10001, P(1, 1)],       // 雨滴墙纸
    [10001, 1],             // 雨滴墙纸（槽位1，同 getLobbyFur）
    [20005, P(3, 3)],       // 暖心地板
    [20001, P(0, 8)],       // 天蓝之星
    [20002, P(0, 4)],       // 和室地板
    [20001, P(0, 3)],       // 天蓝之星
    [20003, P(0, 9)],       // 小电视地板
    [60000, P(5, 13)],      // 派遣中心
    [70000, P(10, 13)],     // 研究所
    [90000, P(2, 14)],      // 补给贩卖机（售货机本体，kind=12 → 气泡 id=5）
    [90001, P(12, 14)],     // 领取金币（kind=10 → 气泡 id=2）
  ];
  return layout.map(([type_id, pos], i) => ({ fur_id: i + 1, type_id, pos }));
}
// 存量档自愈：老档的 furnitures 里没有售货机两台（canAdd=false 也进不了仓库）⇒ 原地补摆。
// 幂等：按 type_id 查重，fur_id 接 nextFurId 往下排。loadState 每次加载调用（零成本查 two id）。
const SPECIAL_DORM_MACHINES = [90000, 90001];
function ensureSpecialFurniture() {
  const fur = S.dormState.furnitures;
  if (!Array.isArray(fur)) return 0;
  const P = (x, y) => (x << 6) + y;
  const spots = { 90000: P(2, 14), 90001: P(12, 14) };
  let added = 0;
  for (const tid of SPECIAL_DORM_MACHINES) {
    if (fur.some(f => Number(f.type_id) === tid)) continue;
    fur.push({ fur_id: S.dormState.nextFurId++, type_id: tid, pos: spots[tid] });
    added++;
    log(`[dorm] 存量自愈：补摆特殊家具 ${tid}（pos=${spots[tid]}）`);
  }
  return added;
}

// 家具仓库初始备货（全部为 CfgHouseFurniture 里 canAdd=true 的合法 ID）
const DEFAULT_WAREHOUSE = {
  10001: 5, 10002: 5, 10003: 5, 10004: 5, 10005: 5, 10006: 5,          // 墙纸
  20001: 10, 20002: 10, 20003: 10, 20004: 10, 20005: 10, 20006: 10,    // 地板
  40001: 5, 40002: 5, 40011: 5, 40012: 5, 40013: 5, 40014: 5,          // 室内家具
  50073: 3, 55000: 1,                                                  // 室外装饰
  80000: 20, 80001: 20, 80002: 20, 80003: 20, 80004: 20, 80005: 20,    // 路面
};

// 协会建筑等级兜底：1 用爱发电/2 信仰充值/3 使命必达(派遣)/4 时光银行（CfgDorm.study + DormConst）
function dormBuildingLv(bdId) {
  return S.dormState.buildings[bdId] || 1;
}

// 协会扩建等级：CfgHouse.level 只有 3 档（客户端 HouseConfig.getSize/getLevelMaxPoint 都按它取数组），
// 传 0 或 >3 会让 level[nil] 在 DormPanel.onGUI / HouseScene.setData 里崩。
// 存档侧已在 state.js 的 loadState 里 clamp，这里再兜一层（GM/未来配置变更都可能绕过 load）。
const HOUSE_MAX_LV = 3;                 // #CfgHouse.level
// CfgHouse.level[n][3] 是**1 基**下标：level[1]={15,15,0,40} / level[2]={20,20,100,110} / level[3]={25,25,500,200}。
// 下标 = 目标等级，[0] 占位不用；客户端 getLevelCost(cur + 1) 取的就是 level[cur+1][3]。
const HOUSE_LEVEL_COST = [0, 0, 100, 500]; // 目标 Lv2 花 100、Lv3 花 500（Lv1 是初始，不可"扩到 1"）
function dormLv() {
  return Math.min(HOUSE_MAX_LV, Math.max(1, Number(S.dormState.lv) || 1));
}

// ==================== 补给站（CfgDorm.supply） ====================
// 客户端链路（bc 实证，见 调研-协会无法扩建.md §Step4）：
//   主城四图标 CfgMain.mainApps App04~App07（data.shelfID=1..4）
//     → MainSupplyAppIcon.isFuncOpen() = DormMgr.isShelfUnlock(shelfID)
//     → 该值**只**由 m_depot_info_toc.shelf[] 里"出现过的 id"置位（DormShelfVO.initByPkvt → isUnlock=true）
//   协会场景补给机（kind=12 家具 90000）→ m_depot_info_tos + openSupplyPanel()
//   购买（DormSupplyBuyPanel.toBuy）→ m_depot_supply_tos{shelf_id, type, opt, currency}
//   解锁（DormSupplyItem.onClick，只有 4 号有 unlockCost/preUnlock）→ m_depot_unlock_shelf_tos{id}
//
// CfgDorm.supply.shelves[i] = {id, name, unlockTip?, unlockCost?, preUnlock?,
//                              [1]=普通{type:1,speed,max,cost:[{id,num}]}, [2]=高级{type:2,...}}
//   · speed = 每小时经验，max = 经验存量上限，cost[].num = **每 10 点经验的耗材数**
//     （客户端 getPer10CostNums 直接回 cost[].num，按钮文案就是它）
//   · opt=1(OPT_TEN) 买 10 份 → +costNum*10 经验；opt=2(OPT_ALL) 买 ceil(costNum*10*(max-remain)/max) 份
//   · cost[0].id 决定货币：30000002 体力(currency=0) / 30000000 水晶(currency=2) / 31000009 协会点(currency=1)
//     ⚠️ tos 里没有道具 id，**价格必须按 shelf_id+type 自己查表**，不能信客户端。
//   · 经验产出对象是 S.dormState.servants（休息位）里**未满级**的誓灵，每人等量
//     （DormSupplyVO.getExpOneHourAll = Σ已解锁货架速率 × 非满级休息誓灵数）
const SHELF_NORMAL = 1, SHELF_ADVANCE = 2;      // DormConst.SHELF_NORMAL / SHELF_ADVANCE
const SUPPLY_SHELVES = [
  {                       // CfgDorm.supply.shelves[1] 特产（默认解锁）
    id: 1, name: '特产',
    normal: { name: '原味小龙虾', speed: 350, max: 50400, cost: [{ id: 30000002, num: 90 }] },
    advance: { name: '九霄麻辣小龙虾', speed: 525, max: 75600, cost: [{ id: 30000000, num: 5 }, { id: 31000009, num: 5 }] },
  },
  {                       // shelves[2] 饮料（协会扩建 1 次自动解锁）
    id: 2, name: '饮料', autoLv: 2,
    normal: { name: '誓灵快乐水', speed: 350, max: 50400, cost: [{ id: 30000002, num: 90 }] },
    advance: { name: '乌尔达劲爽神泉', speed: 525, max: 75600, cost: [{ id: 30000000, num: 5 }, { id: 31000009, num: 5 }] },
  },
  {                       // shelves[3] 速食（协会扩建 2 次自动解锁 = dormLv>=3）
    id: 3, name: '速食', autoLv: 3,
    normal: { name: '原味汤面', speed: 250, max: 72000, cost: [{ id: 30000002, num: 150 }] },
    advance: { name: '高天原龙宫汤面', speed: 375, max: 108000, cost: [{ id: 30000000, num: 8 }, { id: 31000009, num: 8 }] },
  },
  {                       // shelves[4] 能量（2000 协会点解锁，前置 2、3）
    id: 4, name: '能量', unlockCost: 2000, preUnlock: [2, 3],
    normal: { name: '能量块', speed: 250, max: 72000, cost: [{ id: 30000002, num: 150 }] },
    advance: { name: '强无敌能量块XL', speed: 375, max: 108000, cost: [{ id: 30000000, num: 8 }, { id: 31000009, num: 8 }] },
  },
];
const SHELF_BY_ID = Object.fromEntries(SUPPLY_SHELVES.map(s => [s.id, s]));
const ITEM_VIT = 30000002, ITEM_GOLD = 30000000, ITEM_ASS_POINT = 31000009;
// currency 字段（客户端 DormSupplyBuyPanel.convertCurrency）：0=体力、1=协会点、2=水晶
const CUR_VIT = 0, CUR_ASS = 1, CUR_GOLD = 2;
function currencyOfItem(typeId) {
  if (Number(typeId) === ITEM_VIT) return CUR_VIT;
  if (Number(typeId) === ITEM_ASS_POINT) return CUR_ASS;
  if (Number(typeId) === ITEM_GOLD) return CUR_GOLD;
  return -1;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const dayKeyShelf = () => new Date().toLocaleDateString('sv'); // 与 vit.js 的 dayKey 同口径

// 货架解锁判定：1 号默认开；2/3 由扩建等级派生；4 号要显式解锁且前置齐
function shelfUnlocked(id) {
  const cfg = SHELF_BY_ID[id];
  if (!cfg) return false;
  if (cfg.autoLv) return dormLv() >= cfg.autoLv;
  if (cfg.unlockCost) {
    if (!S.dormState.shelves[id] || !S.dormState.shelves[id].unlocked) return false;
    return (cfg.preUnlock || []).every(x => shelfUnlocked(x));
  }
  return true;
}
// 某货架的存档位（惰性创建）。at=上次结算秒，goods/sup_goods=经验存量
function shelfState(id) {
  if (!S.dormState.shelves) S.dormState.shelves = {};
  const cfg = SHELF_BY_ID[id];
  let st = S.dormState.shelves[id];
  if (!st || typeof st !== 'object') {
    st = { goods: 0, sup_goods: 0, free: 0, at: nowSec(), unlocked: !cfg || !cfg.unlockCost };
    S.dormState.shelves[id] = st;
  }
  if (!Number.isFinite(Number(st.goods))) st.goods = 0;
  if (!Number.isFinite(Number(st.sup_goods))) st.sup_goods = 0;
  if (!Number.isFinite(Number(st.free))) st.free = 0;
  if (!Number.isFinite(Number(st.at)) || Number(st.at) <= 0) st.at = nowSec();
  return st;
}
// 每日免费次数：重置跨天（CfgDorm 里没有 free 的数值，官方面板只在 free>0 显示「每日赠送」角标；
// 本地服不给免费库存，保持 0 —— 与"每日赠送"文案共存但永不触发，不影响可玩性）
function shelfDailyReset() {
  const day = dayKeyShelf();
  if (S.dormState.shelfDay !== day) {
    S.dormState.shelfDay = day;
    for (const st of Object.values(S.dormState.shelves || {})) if (st) st.free = 0;
    saveState();
  }
}
// 剩余可用经验（客户端 DormShelfVO.getRemainExp：高级优先）
function shelfRemain(st) {
  return Number(st.sup_goods) > 0 ? Number(st.sup_goods) : Number(st.goods);
}
function shelfRemainOf(id) { return shelfRemain(shelfSettle(id, null)); }
// 未满级的休息位誓灵（补给经验的作用对象）。
// ★ 依据：CfgDorm.supply.expTip 原文「经验值未满的**休息中誓灵**，可自动从补给处获得经验
//   补给处会为每个休息中誓灵提供等量的经验值」；客户端 getNeedExpServantNum 统计的正是
//   m_depot_info_toc.servants 里未满级的 VO ⇒ 这个字段就发休息位誓灵的 id（不是补给站小人，
//   那条走 m_depot_put_servant_tos，本版客户端**从不发送**，属死协议）。
function restServantsUnderMax() {
  const TRAIN = require('../data/train_data');
  return (S.dormState.servants || [])
    .map(d => S.servants.find(b => Number(b.id) === Number(d.servant_id)))
    .filter(b => b && (Number(b.level) || 1) < TRAIN.maxLevelOf(b));
}
// 给一批誓灵各发等量经验，返回 {servants:[{id,exp}], changes}
function grantExpToAll(list, each) {
  const TRAIN = require('../data/train_data');
  const servants = [], changes = [];
  const n = Math.max(0, Math.floor(Number(each) || 0));
  if (n <= 0) return { servants, changes };
  for (const b of list) {
    const r = TRAIN.applyServantExp(b, n);
    if (r.overflow > 0) bankDeposit(r.overflow); // 中途升到满级 → 溢出进时光银行
    if (r.gained > 0) {
      servants.push({ id: b.id, exp: r.gained });
      changes.push({ servant_id: b.id, key: CHANGE_ID_EXP, val: r.exp });
      if (r.level !== r.oldLevel) changes.push({ servant_id: b.id, key: CHANGE_ID_LEVEL, val: r.level });
    }
  }
  return { servants, changes };
}
// 结算：把 elapsed 折算成**从货架取用并真正发给休息誓灵**的经验。
// 官方模型（DormSupplyVO.getExpOneHourAll = Σ已解锁货架速率 × 非满级休息誓灵数）：
//   每个货架每小时给**每只**非满级休息誓灵 `speed` 点 ⇒ 货架消耗 = speed × N × elapsed/3600。
// 返回 {perServant, consumed, servants, changes}。N=0 或不满足条件时 consumed=0（不消耗库存）。
function shelfSettle(id, conn) {
  const cfg = SHELF_BY_ID[id];
  const st = shelfState(id);
  const now = nowSec();
  const elapsed = Math.max(0, now - Number(st.at));
  st.at = now;
  if (elapsed <= 0 || !cfg) return { perServant: 0, consumed: 0, servants: [], changes: [] };
  if (!shelfUnlocked(id)) return { perServant: 0, consumed: 0, servants: [], changes: [] };
  const targets = restServantsUnderMax();
  const N = targets.length;
  if (N === 0) return { perServant: 0, consumed: 0, servants: [], changes: [] };
  // 当前生效速率：高级货有存量就按高级速率（DormShelfVO.isUseAdvance = sup_goods > 0）
  const useAdv = Number(st.sup_goods) > 0;
  const rate = useAdv ? cfg.advance.speed : cfg.normal.speed;
  const wantPer = Math.floor(elapsed * rate / 3600);
  if (wantPer <= 0) return { perServant: 0, consumed: 0, servants: [], changes: [] };
  const stock = shelfRemain(st);
  const canPer = Math.min(wantPer, Math.floor(stock / N));
  if (canPer <= 0) return { perServant: 0, consumed: 0, servants: [], changes: [] };
  // 扣库存：高级优先（与 getRemainExp 同口径）
  let left = canPer * N;
  const fromAdv = Math.min(Number(st.sup_goods) || 0, left);
  st.sup_goods = Math.max(0, (Number(st.sup_goods) || 0) - fromAdv);
  left -= fromAdv;
  if (left > 0) st.goods = Math.max(0, (Number(st.goods) || 0) - left);
  const g = grantExpToAll(targets, canPer);
  if (conn && g.changes.length) pushServantChanges(conn, g.changes);
  return { perServant: canPer, consumed: canPer * N, servants: g.servants, changes: g.changes };
}
// 全部已解锁货架结算（按 id 升序，结果是确定的）。返回汇总。
function shelfSettleAll(conn) {
  let consumed = 0, perServant = 0;
  const servants = new Map(), changes = [];
  for (const cfg of SUPPLY_SHELVES) {
    const r = shelfSettle(cfg.id, null);
    consumed += r.consumed;
    perServant += r.perServant;
    for (const s of r.servants) servants.set(s.id, (servants.get(s.id) || 0) + s.exp);
    changes.push(...r.changes);
  }
  if (consumed > 0 && conn && changes.length) pushServantChanges(conn, changes);
  return { consumed, perServant, servants: [...servants].map(([id, exp]) => ({ id, exp })), changes };
}
// ==================== 场景售货机气泡（HouseFurRewardItem kind=12，二百八十三） ====================
// 协会场景的售货机本体（家具 90000）上要挂一个「N/已解锁数 · 供应中/缺货中」气泡：
//   Furniture.updateReward 按 kind=12 查 HouseMgr.getBuildingReward(12) = rewardDic[5]，
//   而 rewardDic 的**唯一**写入通道是 m_building_reward_notify_toc{id, reward:[{id,val}]}
//   （HouseModule.m_building_reward_notify_toc → HouseMgr.updateBuildingReward）。
//   服务端从未推过 id=5 ⇒ 机器上永远没有气泡，也没有点击入口（气泡 onClick id==5 →
//   openSupplyPanel + m_depot_info_tos，HouseFurRewardItem 实证）。val 口径 =
//   客户端 getFullShelfNum()（非空货架数，锁定货架无库存天然不计）。
// ⚠️ reward 必须**恒发非空数组**：reward=[] 会让 rewardDic[5]=nil 把气泡拆掉；
//   val=0 正是要的「缺货中」形态（onGUI 有专门的飘动动画分支）。
function depotNonEmptyShelves() {
  return SUPPLY_SHELVES.filter(c => shelfUnlocked(c.id) && shelfRemain(shelfState(c.id)) > 0).length;
}
function depotNotify(conn) {
  if (!conn) return;
  conn.sendToc('m_building_reward_notify_toc', {
    id: 5, // getBuildingReward(KIND_GOLD_SUPPLY=12) 的固定槽位（HouseConst 映射 12→5）
    reward: [{ id: 5, val: depotNonEmptyShelves() }],
  });
}
// ==================== 时光银行（CfgDorm.study[4]） ====================
// effect[level] = {转化率%, 储存上限, 繁荣度门槛}；level/cost 两列全 0 ⇒ **等级由繁荣度自动推**，
// 不是玩家点的（DormStudyItem.update 对 bdID==4 隐藏价格/等级门槛，只显示进度条）。
const BANK_EFFECT = [
  [5, 100000, 0], [7.5, 150000, 20], [10, 200000, 40], [12, 250000, 60],
  [14, 300000, 80], [15.5, 350000, 100], [17, 400000, 120], [18, 450000, 140],
  [19, 500000, 160], [19.5, 550000, 180], [20, 600000, 200],
];
// 银行等级 = 繁荣度达到的最高档（DormPointInfoVO 的 expBank 档位同源）
function bankLevel() {
  const p = furnitureProsperity();
  let lv = 1;
  for (let i = 0; i < BANK_EFFECT.length; i++) if (p >= BANK_EFFECT[i][2]) lv = i + 1;
  return lv;
}
function bankCap() { return BANK_EFFECT[bankLevel() - 1][1]; }
function bankRate() { return BANK_EFFECT[bankLevel() - 1][0] / 100; }
// 满级誓灵的溢出经验按转化率入银行（封顶）。返回实际入账量。
// ⚠️ 调用方：applyServantExp 的 overflow（战斗 / 训练 / 补给三条路径）。
function bankDeposit(overflow) {
  const gain = Math.floor(Math.max(0, Number(overflow) || 0) * bankRate());
  if (gain <= 0) return 0;
  const before = Math.floor(Number(S.dormState.bankExp) || 0);
  const after = Math.min(bankCap(), before + gain);
  S.dormState.bankExp = after;
  return after - before;
}
// 提取：把银行存量提给某只誓灵。opt=1(ADD_EXP_ALL) 全取、2(ADD_EXP_ONE) 只取够升一级的量。
// 返回 {add, left}；客户端 m_add_servant_exp_in_time_bank_toc 用 left_exp 覆盖本地余量。
function bankWithdraw(servant, opt) {
  const TRAIN = require('../data/train_data');
  const bank = Math.floor(Number(S.dormState.bankExp) || 0);
  if (bank <= 0) return { add: 0, left: 0 };
  const max = TRAIN.maxLevelOf(servant);
  const level = Number(servant.level) || 1;
  if (level >= max) return { add: 0, left: bank };
  let want = bank;
  if (Number(opt) === 2) { // 提升 1 级：恰好补满本级差额
    const need = TRAIN.needOf(level);
    want = Math.max(1, need - (Number(servant.exp) || 0));
    want = Math.min(want, bank);
  }
  const r = TRAIN.applyServantExp(servant, want);
  const used = r.gained + r.overflow; // 提到满级时多余部分算"用掉了"（否则玩家会看到银行白扣）
  S.dormState.bankExp = Math.max(0, bank - used);
  return { add: used, left: S.dormState.bankExp, r };
}

// ---- 主题（CfgHouse.theme 1..5）----
// 客户端状态机（DormConst.THEME_STATE_*）：1=可解锁(CAN_UNLOCK)、2=已激活(ACTIVE)。
// DormThemeItem.updateState：state==CAN_UNLOCK 播放解锁动画；!=ACTIVE 盖遮罩；ACTIVE 且非当前
// 主题时点击发 m_theme_select_tos，CAN_UNLOCK 时点击发 m_theme_unlock_tos。
// ⚠️ 客户端**没有任何**"从道具解锁主题"的代码（全库 40000000~3 零命中），所以解锁来源由服务端定：
//    这里按官方道具语义（31000009 同族的 40000000~40000003"解锁协会主题X"）**要求背包持有该道具**。
//    主题 1（协会日常）默认开启。
const THEMES = [
  { id: 1, name: '协会日常', item: 0 },          // 默认开启
  { id: 2, name: '安土城下町', item: 40000000 },  // 成就 4000 / 道具
  { id: 3, name: '苍色小城', item: 40000001 },    // 苍色试炼兑换
  { id: 4, name: '大河的馈赠', item: 40000002 },  // 活动
  { id: 5, name: '异世界皇城', item: 40000003 },  // 商城
];
const THEME_UNLOCKED = 2, THEME_CAN_UNLOCK = 1;
function themeOwnedItem(itemId) {
  if (!itemId) return true; // 主题 1
  return S.bagGoods.some(g => Number(g.type_id) === Number(itemId) && Number(g.cur_num) > 0);
}
// 已解锁集合：默认主题 1 + 玩家显式解锁过的（S.dormState.themes）
function themeUnlocked(id) {
  return Number(id) === 1 || Number(S.dormState.themes[id]) === 1;
}
// m_dorm_detail_toc.theme_lists —— 只发**状态非 0** 的条目（客户端 themeDic 缺省即 nil ⇒ 未满足）
function themeList() {
  return THEMES
    .filter(t => themeUnlocked(t.id) || themeOwnedItem(t.item))
    .map(t => ({ id: t.id, val: themeUnlocked(t.id) ? THEME_UNLOCKED : THEME_CAN_UNLOCK }));
}

const SIDE_OUTSIDE = 1, SIDE_INSIDE = 2;   // DormConst.SIDE_OUTSIDE=1 / SIDE_INSIDE=2
// 同时接受 DormConst 的数字（1=室外 / 2=室内）与内部键名（'outside'/'inside'）——
// 前者来自协议字段 out_door，后者是补推 detail / save_toc 时自己用的字面量。
const sideKey = s => {
  if (s === 'inside' || s === 'outside') return s;
  return Number(s) === SIDE_INSIDE ? 'inside' : Number(s) === SIDE_OUTSIDE ? 'outside' : null;
};
function plansOf(side) {
  const k = sideKey(side);
  if (!k) return null;
  if (!Array.isArray(S.dormState.plans[k])) S.dormState.plans[k] = [];
  return S.dormState.plans[k];
}
// 当前"使用中"的方案：室内外各一个 id（没有则为 0）
function currentPlanId(side) {
  const k = sideKey(side);
  if (!k) return 0;
  return Number(S.dormState.currentPlan && S.dormState.currentPlan[k]) || 0;
}
function currentPlan() {
  for (const side of [SIDE_INSIDE, SIDE_OUTSIDE]) {
    const id = currentPlanId(side);
    if (!id) continue;
    const p = (plansOf(side) || []).find(x => Number(x.id) === id);
    if (p) return p;
  }
  return null;
}
const cloneFurnitures = list => (list || []).map(f => ({ fur_id: f.fur_id, type_id: f.type_id, pos: f.pos }));
function planToToc(p) { return { id: Number(p.id), out_door: Number(p.side), img_id: Number(p.imgId) || 1, name: String(p.name || '') }; }
// 重推 detail（主题切换/解锁后让客户端立刻重绘：use_theme、theme_lists 都在 detail 里）。
// 直接内联构造而不复用 handler：handler 定义在 module.exports 的对象字面量里，
// 模块加载期拿不到（同一字面量内部无法引用自身），且冒烟会做 handlers 副本。
function pushDormDetail(conn) {
  if (!conn || typeof conn.sendToc !== 'function') return;
  sendDormDetail(conn, { role_id: roleId });
}
function sendDormDetail(conn, obj) {
  conn.sendToc('m_dorm_detail_toc', {
    role_id: (obj && obj.role_id) || roleId,
    role_name: S.roleName,
    dorm_level: dormLv(),
    furnitures: S.dormState.furnitures,
    slots: S.dormState.slots,
    servants: dormServantList(),
    tourists: [],
    prosperity: furnitureProsperity(),
    like_num: 0,
    has_like: 0,
    use_theme: S.dormState.useTheme,
    theme_lists: themeList(),
    gift_time: require('./feeling').giftTimesLeft(),
    // p_dorm_plan[]：客户端 DormMgr.updateDormDtail 用它建 allPlanDic（Hash，key=id）
    // → DormPlanView 的列表数据源。发空数组 = 玩家已有的方案全部不可见。
    indoor_plans: (S.dormState.plans.inside || []).map(planToToc),
    outdoor_plans: (S.dormState.plans.outside || []).map(planToToc),
    outdoor_plan: currentPlanId('outside'),
    indoor_plan: currentPlanId('inside'),
  });
}
// 名称钳制：客户端 DormPlanAddPanel 输入框限 5 个 utf8 字符（超出会自己截到 6），这里按 8 兜底
function planName(name, side) {
  const s = String(name == null ? '' : name).trim();
  if (s) return s.slice(0, 8);
  // 空名 → "室内方案N"/"室外方案N"（与客户端 DormMgr.getPlanName 的默认口径一致）
  const base = sideKey(side) === 'inside' ? '室内方案' : '室外方案';
  const used = new Set((plansOf(side) || []).map(p => String(p.name)));
  for (let i = 1; i <= 99; i++) if (!used.has(base + i)) return base + i;
  return base;
}

// skin_id 必须真实：HouseServant.onGUI 用 skinToType(skin_id) 取说话配置
// （getSpeakVO(0) → 头顶弹"配置不存在的类型:0"）、getFakerSkin(skin_id) 加载模型
// （skin 0 → 只有 texShadow 阴影没有小人）。pos: 1=室内层（0=街道层）
function dormServantList() {
  return (S.dormState.servants || []).map(s => {
    const b = S.servants.find(x => x.id === s.servant_id);
    return {
      servant_id: s.servant_id,
      slot: s.slot,
      skin_id: (b && b.skin_id) || (b && b.type ? b.type * 100 + 1 : 0),
      pos: s.pos == null ? 1 : s.pos,
      // 誓灵收集（小惊喜）待领取列表（p_kvi[]）。客户端消费点：
      //   主城 MainItemAppIcon 角标 + MainBubblePanel 气泡圈（点气泡发 m_dorm_get_reward_tos）、
      //   宿舍场景誓灵头顶气泡 HouserServantHeadItem。恒空 = 两个入口永不可见。
      reward: (Array.isArray(s.reward) ? s.reward : []).map(x => ({ id: Number(x.id), val: Number(x.val) })),
    };
  });
}

// ---- 收集奖励入包/入资产（get_reward 领取与离位自动入包共用）----
// 分路与派遣领奖 m_building_crusade_reward_tos 同口径：
//   30000003 → 金币（roleAsset.silver + pushAssetChange）  30000002 → 体力（vit.addVit 内部推送）
//   其余 → grantGoods（礼物 28xxxxxx 入礼物包，op=3 推送）。
// 返回 {items, silver, vit, granted} 供回包与日志。
function grantCollectReward(conn, items) {
  const list = (Array.isArray(items) ? items : []).map(x => ({ id: Number(x.id), val: Math.max(1, Number(x.val) || 0) }));
  let silver = 0, vit = 0;
  const granted = [];
  for (const it of list) {
    if (it.id === 30000003) silver += it.val;
    else if (it.id === 30000002) vit += it.val;
    else granted.push(...L.grantGoods(it.id, it.val, conn));
  }
  if (silver) S.roleAsset.silver += silver;
  if (vit) require('./vit').addVit(conn, vit);
  if (silver) pushAssetChange(conn);
  if (granted.length) pushGoodsUpdate(conn, granted, 3);
  return { items: list, silver, vit, granted };
}
const COLLECT_NAME = { 30000003: '金币', 30000002: '体力', 28000000: '雪兔礼物盒', 28000001: '熊猫礼物盒' };
const collectDescribe = items => (items || []).map(x => `${COLLECT_NAME[x.id] || x.id}×${x.val}`).join(' + ') || '空';

// 离位收尾（out / 换槽顶掉共用）：满足度一笔结清 + 未领小惊喜自动入包 + 清 bit10 + 推 key=3。
// 调用方负责把记录从 S.dormState.servants 移除与 saveState。
function leaveRestCleanup(conn, rec) {
  if (!rec) return;
  const sid = Number(rec.servant_id);
  try { require('./feeling').settleLeaveRest(conn, sid); } catch (e) { log(`[dorm] 离位满足度结算异常：${e.message}`); }
  if (Array.isArray(rec.reward) && rec.reward.length) {
    const g = grantCollectReward(conn, rec.reward);
    log(`[dorm] 誓灵 ${sid} 离位：未领小惊喜自动入包（${collectDescribe(g.items)}）`);
  }
  const b = S.servants.find(x => Number(x.id) === sid);
  if (b) {
    const cur = Number(b.status) || 0;
    if (cur & FEELR.STATUS_DORM_REST) {
      b.status = cur & ~FEELR.STATUS_DORM_REST;
      pushServantChanges(conn, [{ servant_id: sid, key: CHANGE_ID_STATUS, val: b.status }]);
    }
  }
}

// 剧情图鉴（CfgTheater.handbooks）：copyID → 该关全部剧情 theaterID。
// 客户端解锁条件 hasPlayed(theaterID)——通关推导（cleared 含 bossPoint 即视为全部看过）
// + m_theatre_play_tos 实际上报的额外记录


// 替换组：同组家具在场景里只允许一件（CfgHouseFurniture.replaceGroup，0=可重复）。
// 墙纸全在组 1、地板全在组 2、室外路面组 5、派遣中心组 3 / 研究所组 4 / 领取体力组 6 / 领取金币组 7。
// 客户端 HouseScene 对这类家具只有一个载体（updateWall 改 texWallCorner、KIND_FLOOR 改 texFloor），
// 所以同组多件时只有"全量重渲染时最后生效的那件"可见 —— 必须靠服务端顶掉旧件，不能累加。
function replaceGroupOf(typeId) {
  return (FUR.FURNITURE[typeId] || {}).replaceGroup || 0;
}

module.exports = {
  handlers: {
// ---- 协会（宿舍/Dorm）----
// 打开协会面板：m_furnitures_list_tos + m_dorm_detail_tos(MyRoleID)。
// 兜底回包会把 dorm_level 填 0，而客户端 CfgHouse.level 是 1..3 的数组——
// HouseConfig.getLevelMaxPoint(0) → level[0] 为 nil → DormPanel.onGUI 索引报错。
// dorm_level 必须发真实等级（S.dormState.lv）：客户端拿它算繁荣度上限
// （getLevelMaxPoint）与室内地图边长（HouseScene 的 getSize）。
m_dorm_detail_tos(conn, obj) {
  // 休息位结算（二百七十四）：满足度自动上涨 + 收集掷骰——打开协会面板是主结算点之一。
  // 锚点在每只誓灵身上，重复调用零增量零推送；异常不阻塞面板。
  try { require('./feeling').restSettle(conn); } catch (e) { log(`[dorm] 休息结算异常：${e.message}`); }
  sendDormDetail(conn, obj);
},
// 家具仓库（content: p_kvt[]——id=家具type_id val=仓库数量 type=已摆放数量）
m_furnitures_list_tos(conn) {
  conn.sendToc('m_furnitures_list_toc', { content: warehouseContent() });
},
// 家具获取唯一正式途径（协会 → 建造按钮 → DormFurnitureMakePanel）：
//   op_type=1 制造（FUR_BUY_TYPE_MAKE，耗 CfgDorm.formula.point 协会点）
//   op_type=2 购买（FUR_BUY_TYPE_BUY，耗 formula.money 水晶）——客户端本地已拦"协会点/水晶不足"与
//   "拥有数达上限"（拥有 = 仓库 val + 场景摆放数），服务端按同口径复检。
// 回包必带 furniture_id/op_type（面板 onGUI("cost") 会按 formula 飞消耗数字，nil 会崩），
// 并紧跟推 m_furnitures_update_toc 增量合并——否则"拥有:N"要到重开面板才刷新。
m_lobby_furniture_buy_tos(conn, obj) {
  const furnitureId = Number((obj && obj.furniture_id) || 0);
  const opType = Number((obj && obj.op_type) || 0);
  const reject = (why) => {
    log(`[dorm] 家具${opType === 2 ? '购买' : '制造'}被拒：${why}`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  };
  const formula = FUR.FORMULA[furnitureId];
  const meta = FUR.FURNITURE[furnitureId];
  if (!formula || !meta) return reject(`家具 ${furnitureId} 无制造配方`);
  if (opType !== 1 && opType !== 2) return reject(`op_type=${opType} 非法`);
  const maxNum = meta.maxNum || 0;
  const owned = (S.dormState.warehouse[furnitureId] || 0) + placedCountOf(furnitureId);
  if (maxNum > 0 && owned >= maxNum) return reject(`${meta.name} 拥有数已达上限（${owned}/${maxNum}）`);
  if (opType === 1) {
    if (formula.point > 0) {
      const have = L.getScore(SCORE_ASS_POINT);
      if (have < formula.point) return reject(`需 ${formula.point} 协会点，当前 ${have}`);
      L.addScore(conn, SCORE_ASS_POINT, -formula.point); // 推 m_role_score_change_toc，面板点数即时刷新
    }
  } else if (formula.money > 0) {
    if ((Number(S.roleAsset.gold) || 0) + (Number(S.roleAsset.gold_given) || 0) < formula.money) {
      return reject(`需 ${formula.money} 水晶，当前 ${S.roleAsset.gold}`);
    }
    costCrystal(formula.money);
    L.pushAssetChange(conn);
  }
  S.dormState.warehouse[furnitureId] = (S.dormState.warehouse[furnitureId] || 0) + 1;
  saveState();
  conn.sendToc('m_lobby_furniture_buy_toc', {
    furniture_id: furnitureId,
    num: 1,            // 本次获得数（当前客户端只消费 op_type/furniture_id）
    stock_update: [],  // 配方材料扣减（本版 CfgDorm.formula.stocks 全空）
    op_type: opType,
  });
  conn.sendToc('m_furnitures_update_toc', {
    content: [{ id: furnitureId, val: S.dormState.warehouse[furnitureId], type: placedCountOf(furnitureId) }],
  });
  log(`[dorm] ${opType === 2 ? '购买' : '制造'}家具 ${furnitureId}(${meta.name}) 入仓库 ×1（现 ${S.dormState.warehouse[furnitureId]}）`);
},
// 摆设编辑：fur_id 已存在=移动/换型，不存在=从仓库取出新件。回 updates（客户端局部刷新）
m_dorm_rearrange_tos(conn, obj) {
  const furId = (obj && obj.fur_id) || 0;
  const typeId = (obj && obj.type_id) || 0;
  const pos = (obj && obj.pos) || 0;
  const removed = [];
  dormEditBegin(); // 编辑动作先保证有撤销点（D-3，快照实现在本文件 warehouseContent 一带）
  let f = S.dormState.furnitures.find(x => x.fur_id === furId);
  if (!f && typeId) {
    // 新摆放：扣仓库库存（有货才放）
    const stock = S.dormState.warehouse[typeId] || 0;
    if (stock > 0) {
      // 唯一组（墙纸/地板/路面/建筑）：先摘掉同组旧件，否则会一条条累加——
      // 客户端每换一次墙纸都用新的 nowTempID(10001,10002…) 当 fur_id，服务端永远走到"新摆放"分支，
      // 旧墙纸留在列表里；m_dorm_save_toc 回全量时 HouseScene.updateAllFurnitures 按 layer 排序
      // （同 layer 保持原序）依次 updateWall，旧墙纸排在前面 → 视觉上"保存后回到原来的墙纸"。
      const grp = replaceGroupOf(typeId);
      if (grp > 0) {
        for (const old of S.dormState.furnitures.filter(x => x !== f && replaceGroupOf(x.type_id) === grp)) {
          S.dormState.warehouse[old.type_id] = (S.dormState.warehouse[old.type_id] || 0) + 1;
          removed.push(old.fur_id);
        }
        if (removed.length) S.dormState.furnitures = S.dormState.furnitures.filter(x => !removed.includes(x.fur_id));
      }
      S.dormState.warehouse[typeId] = stock - 1;
      f = { fur_id: S.dormState.nextFurId++, type_id: typeId, pos };
      S.dormState.furnitures.push(f);
    } else {
      // D-2（协会清单）：库存不足的静默拒绝补日志——回包形状不变（updates:[]/removed:[]），
      // 旧实现"点了没反应"在日志里查无痕迹。
      log(`[dorm] 摆放被拒：家具 ${typeId} 仓库无货（fur_id=${furId}）`);
    }
  } else if (f) {
    if (typeId && typeId !== f.type_id) {
      // 换型：旧件回仓，新件扣库存
      // 先确认新件库存，再执行旧件回仓；否则库存不足时重复请求会凭空复制旧件。
      if ((S.dormState.warehouse[typeId] || 0) > 0) {
        S.dormState.warehouse[f.type_id] = (S.dormState.warehouse[f.type_id] || 0) + 1;
        S.dormState.warehouse[typeId] -= 1;
        f.type_id = typeId;
        // 换型成唯一组家具时，同组的其它件（默认布局里可能有多个同组件）也要摘掉回仓
        const grp = replaceGroupOf(typeId);
        if (grp > 0) {
          for (const old of S.dormState.furnitures.filter(x => x !== f && replaceGroupOf(x.type_id) === grp)) {
            S.dormState.warehouse[old.type_id] = (S.dormState.warehouse[old.type_id] || 0) + 1;
            removed.push(old.fur_id);
          }
          if (removed.length) S.dormState.furnitures = S.dormState.furnitures.filter(x => !removed.includes(x.fur_id));
        }
      } else {
        // D-2：换型库存不足的静默拒绝补日志（位置移动仍生效——pos 不消耗库存）
        log(`[dorm] 换型被拒：家具 ${typeId} 仓库无货，仅更新位置（fur_id=${furId}）`);
      }
    }
    f.pos = pos;
  }
  saveState();
  conn.sendToc('m_dorm_rearrange_toc', {
    dorm_id: (obj && obj.dorm_id) || 1,
    updates: f ? [f] : [],
    // 必须回传被顶掉的旧件：客户端 m_dorm_rearrange_toc 里 DormMgr.removeFurnitures(removed)
    // 才会把旧件从本地列表摘掉，预览不会残留旧墙纸。
    removed,
  });
},
// 保存/切换摆设（op：0=取消、1=保存当前布局、2=套用方案）。
// 客户端 m_dorm_save_toc 的分支：op=1 弹「保存成功」+ updateFurnitures；op=2 会
// `DormMgr.updateSelTheme(theme)` + updateScene + updatePlanView（**切方案后重绘场景的唯一通道**）；
// 其它 op 只 updateFurnitures。
// ⚠️ indoor_plan / outdoor_plan 是"当前使用的方案 id"，客户端收到后就写进 nowPlanIDDic
// （`DormPlanVO.inUse()` 靠它显示"使用中"），所以必须回真实的当前方案 id，不能恒 0。
m_dorm_save_tos(conn, obj) {
  const op = Number((obj && obj.op) || 0);
  // op=1（保存）：把当前场景布局写回"当前方案"，这样编辑完再切走/切回不会丢
  if (op === 1) {
    const cur = currentPlan();
    if (cur) { cur.furnitures = cloneFurnitures(S.dormState.furnitures); saveState(); }
    S.dormState.editBackup = null; // 保存 = 提交，撤销点清掉（D-3）
  } else if (op === 2) {
    S.dormState.editBackup = null; // 套用方案 = 基线更换（与 change_plan 同口径）
  } else if (op === 0 && S.dormState.editBackup) {
    // op=0 取消：回滚到编辑前（D-3）。客户端 op=0 分支只 updateFurnitures ⇒ 先还原再回包
    // 即可让场景回到编辑前；仓库数量变化补 furnitures_update 增量（增量含"被回仓的 type_id"，
    // 只比 restored 少比 current 多都会漏——D16b 口径：全集 diff）。
    const bak = S.dormState.editBackup;
    const before = warehouseContent();
    S.dormState.furnitures = bak.furnitures;
    S.dormState.warehouse = bak.warehouse;
    S.dormState.nextFurId = bak.nextFurId;
    S.dormState.editBackup = null;
    saveState();
    const bMap = new Map(before.map(e => [e.id, e]));
    const changed = warehouseContent().filter(e => {
      const b = bMap.get(e.id);
      return !b || b.val !== e.val || b.type !== e.type;
    });
    if (changed.length) conn.sendToc('m_furnitures_update_toc', { content: changed });
    log(`[dorm] 取消摆设编辑：回滚到编辑前（${bak.furnitures.length} 件，仓库增量 ${changed.length} 类）`);
  }
  conn.sendToc('m_dorm_save_toc', {
    dorm_id: (obj && obj.dorm_id) || 1,
    op,
    furnitures: S.dormState.furnitures,
    outdoor_plan: currentPlanId('outside'),
    indoor_plan: currentPlanId('inside'),
    theme: S.dormState.useTheme,
  });
},
// ---- 主题：切换 / 解锁（DormOperateView 摆设页右侧"主题"标签）----
// 客户端 m_theme_select_toc 是**空实现**（只 return），所以切完不会自己重绘——
// 服务端必须在回包后重推一次 detail（use_theme 变了 → HouseScene.updateTheme 换整套背景/围栏）。
m_theme_select_tos(conn, obj) {
  const id = Number((obj && obj.theme_id) || 0);
  const t = THEMES.find(x => x.id === id);
  if (!t) {
    log(`[dorm] 切主题被拒：主题 ${id} 不存在`);
    conn.sendToc('m_common_tips_toc', { code: 760001 }); // 主题不存在
    return;
  }
  if (!themeUnlocked(id)) {
    log(`[dorm] 切主题被拒：主题 ${id}（${t.name}）未解锁`);
    conn.sendToc('m_common_tips_toc', { code: 760002 }); // 主题未解锁
    return;
  }
  S.dormState.useTheme = id;
  saveState();
  conn.sendToc('m_theme_select_toc', { theme_id: id, status: THEME_UNLOCKED });
  pushDormDetail(conn); // 空实现的 toc 之后必须补 detail，否则场景不换
  log(`[dorm] 切换协会主题 → ${id}（${t.name}）`);
},
// 解锁主题：需要背包里有对应道具（40000000~40000003），消耗 1 个。
m_theme_unlock_tos(conn, obj) {
  const id = Number((obj && obj.theme_id) || 0);
  const t = THEMES.find(x => x.id === id);
  if (!t) {
    log(`[dorm] 解锁主题被拒：主题 ${id} 不存在`);
    conn.sendToc('m_common_tips_toc', { code: 760001 });
    return;
  }
  if (themeUnlocked(id)) {
    // 已解锁：幂等回当前状态（客户端会弹"激活成功"，但状态本来就对，不算假成功）
    conn.sendToc('m_theme_unlock_toc', { theme_id: id, status: THEME_UNLOCKED });
    return;
  }
  if (!t.item) { // 主题 1 不走这条（理论上进不来）
    S.dormState.themes[id] = 1;
    saveState();
    conn.sendToc('m_theme_unlock_toc', { theme_id: id, status: THEME_UNLOCKED });
    return;
  }
  const g = S.bagGoods.find(x => Number(x.type_id) === Number(t.item) && Number(x.cur_num) > 0);
  if (!g) {
    log(`[dorm] 解锁主题被拒：${t.name} 需要道具 ${t.item}，背包里没有`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  g.cur_num = Number(g.cur_num) - 1;
  const del = g.cur_num <= 0;
  if (del) S.bagGoods = S.bagGoods.filter(x => x !== g);
  S.dormState.themes[id] = 1;
  S.dormState.useTheme = id; // 官方道具描述是"解锁并可在协会摆放界面激活"，这里顺手切过去
  saveState();
  L.pushGoodsUpdate(conn, [g], del ? 2 : 3); // 道具被消耗，背包要刷新
  conn.sendToc('m_theme_unlock_toc', { theme_id: id, status: THEME_UNLOCKED });
  pushDormDetail(conn);
  log(`[dorm] 解锁协会主题 ${id}（${t.name}），消耗道具 ${t.item}×1（余 ${del ? 0 : g.cur_num}）`);
},
// ---- 摆设方案（DormPlanView / DormPlanAddPanel）----
// 客户端语义（DormPlanVO + Hash）：
//   · allPlanDic[SIDE_INSIDE=2] / [SIDE_OUTSIDE=1] 两个 Hash，key=方案 id，array 保序
//   · getSidePlanList(side) → Hash.array；不足 9 条时客户端自己补一个 `0` 占位（"新方案"）
//   · add_plan_tos{id, out_door, name}：id = ADD_PLAN_NEW(0) 表示新建，否则表示"复制该方案"
//   · 客户端 add_plan_toc 会 `nowPlanIDDic[out_door] = id` + `updatePlan(true, ...)`，
//     而 updatePlan 里 `allPlanDic[out_door]:add(...)` —— **out_door 必须是 1/2，否则 index nil 崩**
//   · del_plan_toc{id,out_door} → updatePlan(false, id, out_door) → Hash.remove
// 新建/复制方案：id=0 新建（空布局）；否则复制该方案当前的布局
m_dorm_add_plan_tos(conn, obj) {
  const side = Number((obj && obj.out_door) || 0);
  const srcId = Number((obj && obj.id) || 0);
  const list = plansOf(side);
  if (!list) { // out_door 非法会让客户端 allPlanDic[out_door] 为 nil 而崩，绝不能被兜底
    log(`[dorm] 新建方案被拒：out_door=${side}（必须 1=室外 / 2=室内）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  if (list.length >= 9) { // 客户端列表上限 9（DormPlanView.onChangeSide 的 `< 9` 补位逻辑）
    log(`[dorm] 新建方案被拒：${sideKey(side)} 已有 ${list.length} 个（上限 9）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  let furnitures = [];
  if (srcId !== 0) {
    const src = list.find(p => Number(p.id) === srcId);
    if (!src) {
      log(`[dorm] 复制方案被拒：源方案 ${srcId} 不存在（side=${side}）`);
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      return;
    }
    furnitures = cloneFurnitures(src.furnitures);
  }
  const id = Number(S.dormState.nextPlanId) || 1;
  S.dormState.nextPlanId = id + 1;
  const plan = {
    id, side, imgId: ((id - 1) % 9) + 1, // 客户端图标 DormPlanIcon1..9
    name: planName(obj && obj.name, side),
    furnitures,
  };
  list.push(plan);
  saveState();
  conn.sendToc('m_dorm_add_plan_toc', planToToc(plan));
  log(`[dorm] 新建摆设方案 ${id}（${plan.name}，side=${side}，${furnitures.length} 件`
    + `${srcId ? `，复制自 ${srcId}` : '，空布局'}）`);
},
// 切换方案：把该方案的布局整份换到场景上，并用 save_toc(op=2) 让客户端重绘
m_dorm_change_plan_tos(conn, obj) {
  const side = Number((obj && obj.out_door) || 0);
  const id = Number((obj && obj.id) || 0);
  const list = plansOf(side);
  const plan = list && list.find(p => Number(p.id) === id);
  if (!plan) {
    log(`[dorm] 切方案被拒：方案 ${id} 不存在（side=${side}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  // 切走前先把当前场景存回"原来那个方案"，否则玩家编辑过的布局会丢
  const prev = currentPlan();
  if (prev && Number(prev.id) !== id) prev.furnitures = cloneFurnitures(S.dormState.furnitures);
  S.dormState.currentPlan = Object.assign({ inside: 0, outside: 0 }, S.dormState.currentPlan || {});
  S.dormState.currentPlan[sideKey(side)] = id;
  S.dormState.furnitures = cloneFurnitures(plan.furnitures);
  S.dormState.editBackup = null; // 方案已切换，旧编辑撤销点作废（D-3 生命周期）
  saveState();
  // ⚠️ m_dorm_change_plan_toc 是**空 schema**（Proto.lua 里 `= {}`）——多发字段是无害的，
  // 但客户端 handler 本身是空实现，真正驱动重绘的是下面这条 save_toc(op=2)。
  conn.sendToc('m_dorm_change_plan_toc', {});
  // 客户端 change_plan_toc 是空实现 → 用 save_toc(op=2) 触发 updateScene/updatePlanView
  conn.sendToc('m_dorm_save_toc', {
    dorm_id: 1,
    op: 2, // DormConst.SAVE_TYPE_PLAN
    furnitures: S.dormState.furnitures,
    outdoor_plan: currentPlanId('outside'),
    indoor_plan: currentPlanId('inside'),
    theme: S.dormState.useTheme,
  });
  log(`[dorm] 切换摆设方案 → ${id}（${plan.name}，${plan.furnitures.length} 件）`);
},
// 删除方案：客户端 DormPlanView.onClickBtnDel 会先本地拦"最后一个方案不能删"
m_dorm_del_plan_tos(conn, obj) {
  const side = Number((obj && obj.out_door) || 0);
  const id = Number((obj && obj.id) || 0);
  const list = plansOf(side);
  const plan = list && list.find(p => Number(p.id) === id);
  if (!plan) {
    log(`[dorm] 删方案被拒：方案 ${id} 不存在（side=${side}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  if (list.length <= 1) { // 客户端也拦这条，服务端复检
    log(`[dorm] 删方案被拒：${sideKey(side)} 只剩 1 个方案`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  if (Number(currentPlanId(side)) === id) { // 不许删"正在使用"的那个（客户端按钮只在 current 时出现，但复检）
    log(`[dorm] 删方案被拒：方案 ${id} 正在使用中`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  S.dormState.plans[sideKey(side)] = list.filter(p => Number(p.id) !== id);
  saveState();
  conn.sendToc('m_dorm_del_plan_toc', { id, out_door: side });
  log(`[dorm] 删除摆设方案 ${id}（side=${side}，剩 ${S.dormState.plans[sideKey(side)].length} 个）`);
},
// 协会改名：客户端 m_dorm_rename_toc → DormMgr.updateDormName(dorm_id, name)。
// ⚠️ 主面板标题 `getDormName()` 拼的是 **role_name**（"X的协会"），不是这里的 name；
//    `name` 只影响 RoomsPopupPanelItem / DormSelectedPopupPanel 的列表标题。
m_dorm_rename_tos(conn, obj) {
  const name = String((obj && obj.name) == null ? '' : obj.name).trim().slice(0, 8);
  if (!name) {
    log('[dorm] 改名被拒：空名字');
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  S.dormState.name = name;
  saveState();
  conn.sendToc('m_dorm_rename_toc', { dorm_id: (obj && obj.dorm_id) || 1, name });
  log(`[dorm] 协会改名 → 「${name}」`);
},
// ---- 扩建（CfgDorm.pointInfoTips.upgrade / CfgPrefabLang:6084「点击室内区域下方施工处」）----
// 客户端链路（bc + asm 实证，见 调研-协会无法扩建.md §2）：
//   DormPanel.onUpgrade（右上 btnUpgrade 或室内 kind=11 施工处）→ 确认框
//   → m_dorm_upgrade_tos{dorm_id, to_level=当前+1}
//   → m_dorm_upgrade_toc{dorm: **单对象** p_dorm}（schema 标 array，客户端 updatePdorm 直接取 .dorm_id）
//   → DormMgr.updatePdorm 写 dorm_level + updatePanel("detail")
//   → DormPanel.onGUI("detail") → HouseScene.updateBaseMapSize(getSize(dorm_level)) 当场换图。
// 数值来源 CfgHouse.level = {{15,15,0,40},{20,20,100,110},{25,25,500,200}}：
// {边长X, 边长Y, 费用(协会点), 繁荣度上限}。客户端只校验"是否已满级"，不校验繁荣度门槛，
// 所以服务端也不要自创繁荣度拒绝条件。
m_dorm_upgrade_tos(conn, obj) {
  const cur = dormLv();
  const toLevel = Number((obj && obj.to_level) || 0);
  const reject = why => {
    log(`[dorm] 扩建被拒：${why}（当前 Lv${cur}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // D2：拒绝也必须回包，否则客户端弹"网络等待"
  };
  if (!Number.isInteger(toLevel) || toLevel <= cur || toLevel > HOUSE_MAX_LV) {
    return reject(`to_level=${toLevel} 非法`);
  }
  // 客户端只发 cur+1（DormPanel.onUpgrade 的 `m_dorm_upgrade_tos(cur + 1)`）；跳级一律拒。
  if (toLevel !== cur + 1) return reject(`不允许跳级到 Lv${toLevel}`);
  const cost = HOUSE_LEVEL_COST[toLevel] || 0;
  const have = L.getScore(SCORE_ASS_POINT);
  if (have < cost) {
    // CfgErrorCode 482004「当前协会点数不足」type=TYPE_TIP：走 m_common_tips_toc（handleError1，只弹 reason）。
    // 用 m_common_error_toc 会被 handleError 拼成 "482004：当前协会点数不足"（带裸数字）。
    log(`[dorm] 扩建 Lv${cur}→${toLevel} 需 ${cost} 协会点，当前 ${have}，拒绝`);
    conn.sendToc('m_common_tips_toc', { code: 482004 });
    return;
  }
  if (cost > 0) L.addScore(conn, SCORE_ASS_POINT, -cost); // 内部推 m_role_score_change_toc，面板点数即时刷新
  S.dormState.lv = toLevel;
  saveState();
  // ★ 必须是**单对象** p_dorm：schema 标 array，但客户端 updatePdorm(slot0.dorm) 直接取 .dorm_id。
  //   发数组/空数组 → dorm 解成 {} 或 {[1]} → dorm_id 读 nil → 整块跳过（静默，不报错也不刷新）。
  // ⚠️ p_dorm.servants 的子类型是 p_kvi（{id,val}），不是 p_dorm_servant；且 detail.servants
  //   在客户端没有消费方（休息位列表走 DormMgr.getRest，由 m_dorm_detail_toc 建）→ 发空数组最安全。
  conn.sendToc('m_dorm_upgrade_toc', {
    dorm: {
      dorm_id: 1,
      name: S.dormState.name || '',
      level: toLevel,
      slots: S.dormState.slots,
      comfort: 0,
      servants: [],
    },
  });
  log(`[dorm] 扩建 Lv${cur}→${toLevel}（花费 ${cost} 协会点，余 ${L.getScore(SCORE_ASS_POINT)}）`);
},
// ---- 研究所（建筑等级表 + 时光银行）----
// list: p_kvi[]（id=bdID val=等级）。bdID：1 用爱发电/2 信仰充值/3 使命必达(派遣)/4 时光银行
// ⚠️ bd 4 的等级**不是玩家升级出来的**：CfgDorm.study[4] 的 level/cost 两列全 0，
//    官方按繁荣度自动升（effect[level][3] 就是门槛）。DormStudyItem.update 会拿这个 val 直接索引
//    `data.effect[val]`，所以必须发 bankLevel()，发 dormBuildingLv(4)=1 会让第 4 行永远显示 Lv.1、
//    且繁荣度涨上去后进度条分母（effect[1][2]=100000）不跟着变。
m_building_list_tos(conn) {
  conn.sendToc('m_building_list_toc', {
    list: [1, 2, 3, 4].map(id => ({ id, val: id === 4 ? bankLevel() : dormBuildingLv(id) })),
  });
},
// 时光银行详情（研究所第 4 行 / 主城「时光银行」图标 App11）：
//   level = **由繁荣度反推**（CfgDorm.study[4] 的 level/cost 两列全 0，官方不靠玩家升级）；
//   exp   = 银行存量（满级誓灵溢出经验按转化率入账，上限随 level）；
//   lock  = 0（本版恒解锁；客户端 isLockBuilding 读的是 m_building_list 里 bdID=4 的 lock 分支）
m_building_time_bank_detail_tos(conn) {
  conn.sendToc('m_building_time_bank_detail_toc', {
    bd_id: 4,
    level: bankLevel(),
    lock: 0,
    exp: Math.floor(Number(S.dormState.bankExp) || 0),
  });
},
// 时光银行提取（DormExpBankPanel.btnAll / 按住 btnOne）：
//   tos{servant_id, opt}，opt=1(ADD_EXP_ALL) 全取、2(ADD_EXP_ONE) 只取够升一级的量。
// 回包 m_add_servant_exp_in_time_bank_toc{servant_id, add_exp, left_exp, opt}
//   → 客户端 DormMgr.updateBankExp(left_exp) + updateExpBankPanel("onAddExp", opt)
//     + updateStudyPanel + dispatch DORM_EXPBANK_INFO_CHANGE
// ⚠️ 按住 btnOne 会 0.5s 连发（DormExpBankPanel.onUseOne 的 setInterval），**必须幂等**：
//    银行已空 / 誓灵已满级 / 本次提取 0 → 回 m_common_reply_toc（绝不回本协议，
//    否则 updateBankExp 会把余量覆盖成默认值，D11 同款假成功）。
m_add_servant_exp_in_time_bank_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const opt = Number((obj && obj.opt) || 0);
  const b = S.servants.find(s => Number(s.id) === sid);
  const reject = why => {
    log(`[depot/bank] 提取被拒：${why}（servant=${sid} opt=${opt}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  };
  if (!b) return reject('未知誓灵');
  if (opt !== 1 && opt !== 2) return reject(`opt=${opt} 非法（必须 1 全部 / 2 提升1级）`);
  const bank = Math.floor(Number(S.dormState.bankExp) || 0);
  if (bank <= 0) return reject('银行没有经验');
  if ((Number(b.level) || 1) >= TRAIN.maxLevelOf(b)) return reject('誓灵已满级');
  const r = bankWithdraw(b, opt);
  if (!r || r.add <= 0) return reject('本次提取为 0（银行余量不足或已满级）');
  saveState();
  const changes = [{ servant_id: sid, key: CHANGE_ID_EXP, val: r.r.exp }];
  if (r.r.level !== r.r.oldLevel) changes.push({ servant_id: sid, key: CHANGE_ID_LEVEL, val: r.r.level });
  pushServantChanges(conn, changes);
  conn.sendToc('m_add_servant_exp_in_time_bank_toc', {
    servant_id: sid,
    add_exp: r.add,
    left_exp: r.left,
    opt,
  });
  log(`[dorm] 时光银行提取 servant=${sid} ${opt === 1 ? '全部' : '提升1级'} +${r.add}`
    + ` Lv${r.r.oldLevel}→Lv${r.r.level} 余 ${r.left}/${bankCap()}`);
},
// 建筑升级：等级 +1 回执（消耗校验省略）
m_building_upgrade_tos(conn, obj) {
  const bdId = Number((obj && obj.bd_id) || 0);
  if (!Number.isInteger(bdId) || bdId < 1 || bdId > 4) {
    log(`[dorm] 拒绝非法建筑升级 bd=${bdId}`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  if (bdId === 4) {
    // 时光银行不靠玩家升级（CfgDorm.study[4] 的 level/cost 全 0，按繁荣度自动升），
    // 客户端 DormStudyItem 也把它的"升级"按钮改成了"转化"入口。显式拒绝防被改包刷级。
    log('[dorm] 时光银行(bd=4) 不支持手动升级（等级由繁荣度自动推）');
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  const current = dormBuildingLv(bdId);
  const maxLv = buildingMaxLevel(bdId);
  if (current >= maxLv) {
    log(`[dorm] 建筑已达上限 bd=${bdId} lv=${current}/${maxLv}`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  S.dormState.buildings[bdId] = current + 1;
  saveState();
  conn.sendToc('m_building_upgrade_toc', { bd_id: bdId, level: S.dormState.buildings[bdId] });
  log(`[dorm] 建筑升级 bd=${bdId} → lv${S.dormState.buildings[bdId]}`);
},
// 建筑产出领取（用爱发电=体力 / 信仰充值=金币）：实现在 handlers/vit.js
//（按小时累计 + 储存上限 + 领取后重推气泡），这里不再定义同名 handler 以免互相覆盖
// ---- 派遣中心（使命必达，bd_id=3）----
// 客户端契约（bc/lua_sym 实证，详见 调研-派遣系统.md）：
//   · crusade_list = **可接任务 id 清单**（不含已派遣的；进行中的队伍走 troops）。客户端对每个 id 调
//     DormConfig.getDispatchVO(id) 建 DormDispatchVO —— 配置里没有的 id 会 printError 且返回 nil，
//     后续 table.clear/insert 直接崩，所以清单必须出自 CfgDorm.dispatchs。
//   · level = 派遣室等级，客户端 DormMgr.dispatchLevel 只从这里来，决定"同时可派几队"
//     （CfgDorm.study[3].effect[lv][2] = 1/2/3/4/4）。
//   · troop（dispatch_toc）= **单对象**（见下方 dispatch handler 注释）。
//   · ⚠️ 客户端 DormMgr.dispatchNum 只在 initDispatchDetail（本 toc）里与服务端 troops 对账，
//     dispatch_toc 只 +1、cancel_toc 只 -1，**reward_toc 既不 -1 也不清 dbInfo**
//     ⇒ 领奖后必须补推本 toc，否则客户端 dispatchNum 虚高、面板永远弹"派遣队列已到上限"。
//     这就是"派遣只能派一队"的根因（调研 §1.0）。
m_building_crusade_detail_tos(conn, obj) {
  sendCrusadeDetail(conn, obj && obj.bd_id);
},
// 派遣：记录队伍 + 按配置定时长 + 置 status 派遣位。troop 必须**单对象**下发——客户端 handler
// 直接 slot0.troop.crusade_id（schema 标 array 但官方按单 104 对象，同 bag 模式），
// 发数组会让 troop.crusade_id=nil → getDispatchVO(nil) "table index is nil"
m_building_crusade_dispatch_tos(conn, obj) {
  const crusadeId = Number((obj && obj.crusade_id) || 0);
  const ids = ((obj && obj.servant_ids) || []).map(Number).filter(id => Number.isInteger(id) && id > 0);
  const troops = Array.isArray(S.dormState.troops) ? S.dormState.troops : [];
  const dormServants = Array.isArray(S.dormState.servants) ? S.dormState.servants : [];
  const reject = (code, why) => {
    log(`[dorm] 派遣被拒(${code}) task=${crusadeId} servants=[${ids.join(',')}]：${why}`);
    conn.sendToc('m_common_tips_toc', { code });
  };
  const task = DISP.TASKS[crusadeId];
  if (!task || task.type !== 1) return reject(206004, '找不到派遣任务配置');
  if (troops.some(t => Number(t.crusade_id) === crusadeId)) return reject(208002, '该任务已在派遣中');
  if (ids.length < 1 || ids.length > 6) return reject(206005, `队伍人数 ${ids.length} 非法（1~6）`);
  if (new Set(ids).size !== ids.length) return reject(206006, '队内誓灵 id 重复');
  if (troops.length >= dispatchCap()) {
    return reject(206003, `队列已满 ${troops.length}/${dispatchCap()}（派遣室 Lv${dormBuildingLv(3)}）`);
  }
  const bs = ids.map(id => S.servants.find(s => Number(s.id) === id));
  if (bs.some(b => !b)) return reject(206005, '誓灵不存在');
  // 占用来路有两：真实派遣位/战斗位（status 4/8）与进行中的其它派遣队。位先经真相源自愈
  //（healBusyBits），过期的位就地清除再放行——旧实现直接看位，运行期漏释放的残留位会把
  // 明明空闲的誓灵永久拒之门外（本条工单的用户反馈）。
  const busy = healBusyBits(conn, ids);
  if (busy.length) {
    return reject(206001, `status 真实占用（${busy.join(',')}）`);
  }
  if (ids.some(id => troops.some(t => (t.servant_ids || []).some(x => Number(x) === id)))) {
    return reject(206001, '该誓灵已在其它派遣队');
  }
  // 休息位誓灵：**不拒绝，出发时自动离位**。官方客户端的选人面板刻意隐藏"休息中"徽标
  //（DormDispatchSelectItem.onGUI 的 getStateTip 屏蔽表含 STATUS_WORK）、点击不拦休息位、
  // 一键选择（getCanAutoServants）也照选——硬拒只会弹误导性 206001「有誓灵已在派遣或编队中」，
  // 玩家对着派不出去的休息位誓灵无从自救（2026-10-31 真机日志 5 连拒实锤）。离位收尾与
  // out/顶掉同口（leaveRestCleanup：满足度结清 + 小惊喜自动入包 + 清位10），在成功路径执行，
  // 后续任一校验失败（条件/体力）都不产生离位副作用。
  const restLeft = ids
    .map(id => dormServants.find(x => Number(x.servant_id) === Number(id)))
    .filter(Boolean);
  // 客户端 onCheckSelect 拦的是 **typeId** 重复（同卡不同实例也不行），服务端按同口径
  if (new Set(bs.map(b => Number(b.type))).size !== bs.length) return reject(206006, '队内有相同誓灵（typeId 重复）');
  const condErr = checkDispatchConds(task, bs);
  if (condErr) return reject(condErr, `条件不满足（${JSON.stringify(task.conds)}）`);
  const vitCost = dispatchVitCost(task);
  if (vitCost > 0) require('./vit').addVit(conn, -vitCost); // 出发即扣，中止不返还（官方 Alert 文案）

  const troop = { crusade_id: crusadeId, servant_ids: ids, end_time: Math.floor(Date.now() / 1000) + Number(task.time) };
  S.dormState.troops = troops.filter(t => Number(t.crusade_id) !== crusadeId);
  S.dormState.troops.push(troop);
  // 派遣位：status bit2（=4，ServantConst.STATUS_DISPATCH）。不置位的话客户端选人面板的
  // ServantUtil.isDispatch 恒 false（派出的人还能被选中）、chaos_data.isBusy 也不拦暗噬等。
  const statusChanges = [];
  for (const b of bs) {
    const st = (Number(b.status) || 0) | 4;
    if (st !== (Number(b.status) || 0)) { b.status = st; statusChanges.push({ servant_id: b.id, key: CHANGE_ID_STATUS, val: st }); }
  }
  // 派遣自动离位（在成功路径执行）：满足度结清 + 小惊喜自动入包 + 清位10（key:3 先推，
  // 末尾的派遣位 key:3 携最终值覆盖）+ 全量 p_dorm_servant 列表刷新（与入住/顶掉同口，
  // 客户端 updateDormsServantList 整表替换，协会场景/休息弹窗/补给站面板同步）。
  if (restLeft.length) {
    for (const rec of restLeft) leaveRestCleanup(conn, rec);
    const leftIds = new Set(restLeft.map(r => Number(r.servant_id)));
    S.dormState.servants = (Array.isArray(S.dormState.servants) ? S.dormState.servants : [])
      .filter(s => !leftIds.has(Number(s.servant_id)));
    conn.sendToc('m_dorm_servant_in_toc', { dorm_id: 1, servants: dormServantList() });
    log(`[dorm] 派遣自动离位：${[...leftIds].join(',')}（休息位剩 ${S.dormState.servants.length} 位）`);
  }
  saveState();
  conn.sendToc('m_building_crusade_dispatch_toc', { bd_id: 3, troop });
  // S0：补推 detail，让客户端 dispatchNum 与 troops 对账（连点两个任务时纠正双加）
  sendCrusadeDetail(conn);
  if (statusChanges.length) pushServantChanges(conn, statusChanges);
  advanceMissions(conn, { dispatch: true }); // 任务：完成远征室派遣（condType 8）
  try { require('./act_extra').actEvent(conn, 'dispatch', 1, null); } catch (e) { /* 忽略 */ }
  // 言灵录："X参与一次派遣"的条件判定（出发即算参与）
  try { require('./moment').checkUnlocks(conn); } catch (e) { /* 言灵录异常不阻塞派遣 */ }
  log(`[dorm] 派遣 task=${crusadeId}(${task.name}) 誓灵=[${ids.join(',')}] `
    + `时长 ${task.time}s${vitCost ? ` 体力-${vitCost}` : ''} end=${troop.end_time}`);
},
// 召回派遣队。三种情况必须区分（客户端 cancel_toc 只做 dispatchNum-1 + clearTroop，回包内容
// 不影响 UI，但"已完成还取消"会**白丢奖励**，所以必须拒）：
//   · 队列里没有 → 208001；· 已完成 → 208002（保护奖励）；· 合法中止 → 删队 + 清 status 位
// ⚠️ 回包必须是**真实 crusade_id**：旧代码用 defaultFill() 发 {bd_id:0, crusade_id:0}，
//    客户端 getDispatchVO(0) 返回 nil → `:clearTroop()` 报 "attempt to call method (a nil value)"。
m_building_crusade_cancel_tos(conn, obj) {
  const crusadeId = Number((obj && obj.crusade_id) || 0);
  const troops = Array.isArray(S.dormState.troops) ? S.dormState.troops : [];
  const troop = troops.find(t => Number(t.crusade_id) === crusadeId);
  if (!troop) {
    log(`[dorm] 召回被拒(208001) task=${crusadeId}：队列里没有这个任务`);
    conn.sendToc('m_common_tips_toc', { code: 208001 });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(troop.end_time) <= now) {
    log(`[dorm] 召回被拒(208002) task=${crusadeId}：已完成，请领奖（避免白丢奖励）`);
    conn.sendToc('m_common_tips_toc', { code: 208002 });
    return;
  }
  S.dormState.troops = troops.filter(t => Number(t.crusade_id) !== crusadeId);
  const statusChanges = [];
  for (const sid of troop.servant_ids || []) {
    const b = S.servants.find(s => Number(s.id) === Number(sid));
    if (!b) continue;
    const st = (Number(b.status) || 0) & ~4;
    if (st !== (Number(b.status) || 0)) { b.status = st; statusChanges.push({ servant_id: b.id, key: CHANGE_ID_STATUS, val: st }); }
  }
  saveState();
  conn.sendToc('m_building_crusade_cancel_toc', { bd_id: 3, crusade_id: crusadeId });
  // S0：补推 detail —— 客户端靠它清 dbInfo（否则卡片一直显示"派遣完成"）并重算 dispatchNum
  sendCrusadeDetail(conn);
  if (statusChanges.length) pushServantChanges(conn, statusChanges);
  log(`[dorm] 派遣中止 task=${crusadeId} 誓灵=[${(troop.servant_ids || []).join(',')}]`);
},
// 派遣历史（客户端"自动选择"按钮：hasGetHistory=false 时发本协议并注册 doSelect 回调）。
// 此前未实现 → fallback 回 m_common_reply_toc → 回调永不执行，且第二次点击的 doSelect
// 读 lastDispatchServantList（nil）崩（2026-10-17 azhi 真机 ×2）。
// 回包 {crusade_id, servants:[上次派遣的 servant_ids]}：DormMgr.setLastDispatchServantList 建
// uv0[crusade_id] 缓存 + 立即执行注册的回调。空数组安全（#list==0 走 doNoHistorySelect 智能选择）。
// 历史 = 完成领取后被清的队伍拿不到了，这里放宽为"含进行中的派遣"（客户端语义就是"上次派了谁"）。
m_building_crusade_history_tos(conn, obj) {
  const crusadeId = (obj && obj.crusade_id) || 0;
  const troop = (S.dormState.troops || []).find(t => Number(t.crusade_id) === Number(crusadeId));
  const servants = troop && Array.isArray(troop.servant_ids) ? troop.servant_ids.map(Number).filter(Boolean) : [];
  conn.sendToc('m_building_crusade_history_toc', { crusade_id: crusadeId, servants });
  log(`[dorm] 派遣历史 task=${crusadeId} → [${servants.join(',')}]${troop ? '' : '（无进行中队伍，空表走智能选择）'}`);
},
// 领取派遣奖励。产物**按 CfgDorm.dispatchs[id].rewards 发放**（每项 [typeId, min, max]，区间内随机），
// 不再硬编码"水晶30/金币500/誓灵经验100"（旧实现与配置全无关系，协会点/进化素材/结晶一件都没发过）。
// 货币分路与 activity.grantRewardItems 同口径：
//   30000001 → 御灵士经验（ItemConst.TYPE_ID_EXP；applyRoleExpGain；回包后再推，避免抢在结果面板前）
//   30000002 → 体力（addVit）  30000003 → 金币（silver）  30000000 → 水晶（gold，**不加 gold_given**）
//   31000009 → 协会点（role_scores[4]，grantScoreItem 内部推送）  其余 → grantGoods 入包
// servant_exps：誓灵经验按 40 + time/60（1h=100，与旧基线一致；见 调研 §3.6）。
// ⚠️ 顺序：结果面板第 1 张卡会播派遣语音，取自 HandbookConfig.getServantDialogue(type)[24]；
//    若第一名恰好是缺 dispatch 语音的 typeId 会 nil 崩，所以按"有 24 号台词优先"重排。
m_building_crusade_reward_tos(conn, obj) {
  const crusadeId = Number((obj && obj.crusade_id) || 0);
  const troops = Array.isArray(S.dormState.troops) ? S.dormState.troops : [];
  const troop = troops.find(t => Number(t.crusade_id) === crusadeId);
  if (!troop) {
    log(`[dorm] 领奖被拒(210001) task=${crusadeId}：队列里没有这个任务`);
    conn.sendToc('m_common_tips_toc', { code: 210001 });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(troop.end_time) > now) {
    log(`[dorm] 领奖被拒(210002) task=${crusadeId}：尚未完成 end=${troop.end_time} now=${now}`);
    conn.sendToc('m_common_tips_toc', { code: 210002 });
    return;
  }
  const task = DISP.TASKS[crusadeId];
  if (!task) {
    // 任务配置被删/存档残留：仍要清队（否则永久占队列），但按"找不到配置"回提示
    S.dormState.troops = troops.filter(t => Number(t.crusade_id) !== crusadeId);
    saveState();
    conn.sendToc('m_common_tips_toc', { code: 206004 });
    log(`[dorm] 领奖清除残留队伍 task=${crusadeId}：CfgDorm.dispatchs 无此任务`);
    return;
  }

  // ---- 产物（按配置随机区间） ----
  const effMul = 1 + 0.02 * require('./grow').starLv(44); // 星图节点 44：派遣资源 +2%/级
  const rewards = [];
  const grantedGoods = [];
  let silverGain = 0, goldGain = 0, vitGain = 0, roleExpGain = 0;
  for (const r of task.rewards || []) {
    const typeId = Number(r[0]), lo = Number(r[1]), hi = Number(r[2]);
    if (!typeId) continue;
    // 区间随机；资源类（金币/体力/御灵士经验）吃星图效率加成，道具类不吃
    const roll = lo >= hi ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
    const isResource = typeId === 30000001 || typeId === 30000002 || typeId === 30000003 || typeId === 30000000;
    const num = isResource ? Math.round(roll * effMul) : roll;
    if (num <= 0) continue;   // [0,1] 摇到 0 = 该次没掉，属官方区间语义
    // 死箱转换（二百七十八）：进化素材Lv1/2/3 客户端无消费口，grantGoods 发放时转百变素材模型；
    // 结算面板是"这次实际得到什么"的一次性展示，必须报实收 id（预览类界面才允许保持官方配置原样）
    rewards.push({ type: L.substituteBoxTypeId(typeId), num });
    if (typeId === 30000003) silverGain += num;
    else if (typeId === 30000000) goldGain += num;
    else if (typeId === 30000002) vitGain += num;
    else if (typeId === 30000001) roleExpGain += num;
  }
  // 货币/积分/体力落账
  if (silverGain) S.roleAsset.silver += silverGain;
  // ⚠️ 只加 gold，不加 gold_given：gold 是"水晶总量"，gold_given 是"其中赠送部分"，
  //    派遣不是赠送来源（旧实现两个都加 → 顶栏"赠送水晶"虚增）
  if (goldGain) S.roleAsset.gold += goldGain;
  for (const rw of rewards) {
    const typeId = rw.type;
    if (typeId === 30000003 || typeId === 30000000 || typeId === 30000002 || typeId === 30000001) continue;
    if (L.grantScoreItem(conn, typeId, rw.num)) continue;  // 31000009 协会点等道具形态积分
    const got = L.grantGoods(typeId, rw.num, conn);
    for (const g of got) grantedGoods.push(g);
  }
  if (vitGain) require('./vit').addVit(conn, vitGain);

  // ---- 誓灵经验 + 清 status ----
  const servantExp = 40 + Math.floor(Number(task.time) / 60);
  const servantExps = [];
  const servantChanges = [];
  const doneTypes = [];
  for (const sid of troop.servant_ids || []) {
    const b = S.servants.find(s => Number(s.id) === Number(sid));
    if (!b) continue;
    doneTypes.push(Number(b.type));
    const r = TRAIN.applyServantExp(b, servantExp);
    servantExps.push({ id: b.id, val: r.gained });
    if (r.gained > 0) {
      servantChanges.push({ servant_id: b.id, key: CHANGE_ID_EXP, val: r.exp });
      if (r.level !== r.oldLevel) servantChanges.push({ servant_id: b.id, key: CHANGE_ID_LEVEL, val: r.level });
    }
    if (r.overflow > 0) bankDeposit(r.overflow); // 满级溢出 → 时光银行（与训练/战斗同口径）
    const st = (Number(b.status) || 0) & ~4;
    if (st !== (Number(b.status) || 0)) { b.status = st; servantChanges.push({ servant_id: b.id, key: CHANGE_ID_STATUS, val: st }); }
  }
  // 结果面板第 1 张卡会播放派遣语音（AUDIO_DISPATCHER=24）；排第一的若缺该段台词
  // 客户端 `getServantDialogue(type)[24].text` 会 index nil 崩。把有台词的排前面。
  servantExps.sort((a, b) => {
    const ha = hasDispatchVoice(a.id) ? 0 : 1, hb = hasDispatchVoice(b.id) ? 0 : 1;
    return ha - hb;
  });

  S.dormState.troops = troops.filter(t => Number(t.crusade_id) !== crusadeId);
  try { require('./achievement').addDispatch(); } catch (e) { /* 忽略 */ } // 成就 34xxx 派遣次数
  saveState();

  // ---- 推送（结算类：全部账目先落，回执最后；D3）----
  if (silverGain || goldGain) pushAssetChange(conn);
  if (grantedGoods.length) pushGoodsUpdate(conn, grantedGoods, 3);
  if (servantChanges.length) pushServantChanges(conn, servantChanges);
  if (roleExpGain) {
    const r = L.applyRoleExpGain(roleExpGain);
    if (r.leveledUp) L.pushRoleLevelup(conn); else L.pushRoleExpChange(conn);
    log(`[dorm] 派遣御灵士经验 +${r.gained}：Lv${r.oldLevel} → Lv${r.level}`);
  }
  conn.sendToc('m_building_crusade_reward_toc', {
    bd_id: 3,
    crusade_id: crusadeId,
    servant_exps: servantExps, // 派遣誓灵实际获得的经验（第一名优先带派遣语音）
    rewards,
  });
  // S0：补推 detail —— 客户端 dispatchNum 不因领奖而递减，只有本 toc 能对账（调研 §1.0）
  sendCrusadeDetail(conn);
  // 言灵录："使用X（X、Y同时）完成一次派遣"——以**领奖**为"完成"，按该队誓灵类型组记账
  try {
    const MM = require('./moment');
    MM.onDispatchDone(doneTypes);
    MM.checkUnlocks(conn);
  } catch (e) { /* 言灵录异常不阻塞派遣奖励 */ }
  log(`[dorm] 派遣奖励 task=${crusadeId}(${task.name}) 完成：`
    + `金币+${silverGain} 水晶+${goldGain} 体力+${vitGain} 御灵士经验+${roleExpGain}`
    + ` 道具=[${grantedGoods.map(g => `${g.type_id}x${g.cur_num}`).join(',') || '无'}]`
    + ` 誓灵经验+${servantExp}/只${effMul > 1 ? `（效率提升×${effMul.toFixed(2)}）` : ''}`);
},
// 协会列表（打开选人弹窗 DormSelectedPopupPanel.open 时发）。客户端 updateDormList 只消费
// dorm_id/slots（S.servants 随后 m_dorm_detail_toc 全量下发），单协会即可。
// ⚠️ dorms 这里是**真数组**（schema 标 array 且客户端 ipairs 它），与 upgrade/unlock 的单对象不同。
m_dorm_list_tos(conn) {
  conn.sendToc('m_dorm_list_toc', {
    dorms: [{
      dorm_id: 1,
      name: '',
      level: dormLv(),
      slots: S.dormState.slots,
      comfort: 0,
      servants: [],
    }],
  });
},
// ---- 誓灵入住列表（打开协会主页 MainAppPanel.onOpen 时发）----
// 客户端 m_dorm_servants_toc → DormMgr.updateDormServant(servants) → 建 u0_2[servant_id]
// → 派发 ON_DORM_SERVANTS_TOC（DormRestPopupPanel 等靠它刷新）。
// 此前未实现 → defaultFill 发 {dorm_id:0, servants:[]}，不算错但**永远空转**（server.log 3 次命中）。
// 形状 = p_dorm_servant[]，与 detail/in_toc 共用 dormServantList()。
m_dorm_servants_tos(conn, obj) {
  try { require('./feeling').restSettle(conn); } catch (e) { /* 休息结算异常不阻塞 */ }
  conn.sendToc('m_dorm_servants_toc', {
    dorm_id: (obj && obj.dorm_id) || 1,
    servants: dormServantList(),
  });
},
// ---- 誓灵在室内/室外之间挪位（拖拽后客户端发）----
// {id, pos}：pos 1=室内层、0=街道层（HouseScene.updateAllServant 里 `if p.pos == 1 then 室内 else 室外`）。
// ⚠️ 客户端 `m_dorm_servant_pos_toc` 只传 1 个参数给 `updateDormServantPos(id, pos)`（asm 实证
// `CALL 1 1 2`），所以**回包不会让画面立刻变**（拖动本身已经改了父节点，当场是生效的）；
// 真正决定"重进协会还在不在原来那层"的是服务端落盘 + 下一次 m_dorm_detail_toc 的 servants[].pos。
// 此前未实现 → 兜底 common_reply，pos 从不落盘，重进面板誓灵必定回退到 pos=1。
m_dorm_servant_pos_tos(conn, obj) {
  const sid = Number((obj && obj.id) || 0);
  const pos = Number(obj && obj.pos);
  const rec = (S.dormState.servants || []).find(s => Number(s.servant_id) === sid);
  if (!rec) {
    log(`[dorm] 挪位：誓灵 ${sid} 不在休息位，忽略`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  if (pos !== 0 && pos !== 1) {
    log(`[dorm] 挪位：非法 pos=${pos}（誓灵 ${sid}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  const before = rec.pos == null ? 1 : Number(rec.pos);
  rec.pos = pos;
  saveState();
  // 回显必须与请求同形状：客户端 updateDormServantPos 用 slot0.id / slot0.pos
  conn.sendToc('m_dorm_servant_pos_toc', { id: sid, pos });
  log(`[dorm] 誓灵 ${sid} 挪位 ${before === 1 ? '室内' : '室外'}→${pos === 1 ? '室内' : '室外'}`);
},
// ---- 清空摆设（DormOperateView.onClear）----
// tos: {dorm_id, excludes:int[]}——excludes 是**要保留的 fur_id**（客户端只把"特殊件"塞进去：
// HouseUitl.isSpecialFurKind = 墙纸/地板/室外建筑/路面/体力机/金币机/补给机 这 8 个 kind）。
// 语义：把**不在 excludes 里**的摆设从场景摘掉并回仓库，excludes 里的原地不动。
// ⚠️ 此前未实现 → defaultFill 回 `{dorm_id:0, furnitures:[]}`，客户端 `updateAllFurnitures([])`
// 把本地清空 ⇒ 看着"清空成功"，但服务端没动、家具也没回仓，重进面板全回来（D11 类假成功）。
m_dorm_reset_tos(conn, obj) {
  const keep = new Set((((obj && obj.excludes) || []).map(Number).filter(Number.isInteger)));
  dormEditBegin(); // 清空也是编辑动作：先保证有撤销点，取消才能回到清空前（D-3 同款）
  const before = S.dormState.furnitures.length;
  const kept = [];
  const touched = new Set(); // 受影响的 type_id（被移除的 + 留下的）——增量推送要用
  let back = 0;
  for (const f of S.dormState.furnitures) {
    touched.add(Number(f.type_id));
    if (keep.has(Number(f.fur_id))) { kept.push(f); continue; }
    // 回仓：与 m_dorm_rearrange_tos 的"换型/顶掉"同口径，按 type_id 累加
    S.dormState.warehouse[f.type_id] = (S.dormState.warehouse[f.type_id] || 0) + 1;
    back++;
  }
  S.dormState.furnitures = kept;
  saveState();
  conn.sendToc('m_dorm_reset_toc', { dorm_id: (obj && obj.dorm_id) || 1, furnitures: kept });
  // 仓库数量变了（家具回仓）→ 必须推增量，否则编辑器里"拥有:N"要重开面板才刷新。
  // 注意 touched 必须是"**被移除**的 + 留下的"全集：只用 kept 会漏掉刚回仓的那几类。
  if (back > 0) {
    conn.sendToc('m_furnitures_update_toc', {
      content: [...touched].sort((a, b) => a - b).map(id => ({
        id, val: S.dormState.warehouse[id] || 0, type: placedCountOf(id),
      })),
    });
  }
  log(`[dorm] 清空摆设：移除 ${back} 件回仓，保留 ${kept.length} 件（excludes ${keep.size} 个）`
    + `，场景 ${before}→${S.dormState.furnitures.length}`);
},
// 誓灵入住休息位：{dorm_id, slot, servant_id}；回全量 p_dorm_servant 列表驱动面板刷新
m_dorm_servant_in_tos(conn, obj) {
  const slot = Number((obj && obj.slot) || 0);
  const sid = Number((obj && obj.servant_id) || 0);
  // 拒绝分支一律回包（D2）：裸 return 会让客户端弹 NetWaitPanel 转圈
  const reject = why => {
    log(`[dorm] 入住被拒：${why}（slot=${slot} servant=${sid}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  };
  if (slot < 1 || slot > 6 || slot > S.dormState.slots) {
    return reject(`非法槽位（已解锁 ${S.dormState.slots}）`);
  }
  const b = S.servants.find(s => Number(s.id) === sid);
  if (!b) return reject('未知誓灵');
  // 过期派遣位先自愈（同 healBusyBits 注释）：位 4 残留会让入住被误拒。
  healBusyBits(conn, [sid]);
  // 派遣中不能入住：反方向的互斥（派遣出发时会自动离位，见 dispatch handler；反向仍硬拦）。
  // 不拦的话同一只誓灵可以同时"派遣中 + 休息中"，补给站还会给外面的人发休息经验。
  if (((Number(b.status) || 0) & 4)
    || (S.dormState.troops || []).some(t => (t.servant_ids || []).some(x => Number(x) === sid))) {
    return reject('该誓灵正在派遣中');
  }
  // 同一誓灵换槽：保留原记录（since/collectAt 锚点不清零，休息时长不因换槽损失）；
  // 目标槽原入住者 = 被顶掉离位：满足度结清 + 未领小惊喜自动入包 + 清 bit10。
  const prevSelf = S.dormState.servants.find(s => s.servant_id === sid);
  S.dormState.servants = S.dormState.servants.filter(s => s.servant_id !== sid);
  leaveRestCleanup(conn, S.dormState.servants.find(s => s.slot === slot));
  S.dormState.servants = S.dormState.servants.filter(s => s.slot !== slot);
  S.dormState.servants.push(prevSelf
    ? Object.assign(prevSelf, { slot })
    : { servant_id: sid, slot, since: Math.floor(Date.now() / 1000), collectAt: Math.floor(Date.now() / 1000), reward: [] });
  // 休息位标记：ServantUtil.isDormRest = BitUtil.getIntNBit(status,10)（1-indexed 自 LSB）= 值 512。
  // 主城收集图标 DormMgr.getDormRewardServants 只数 isDormRest 的誓灵，不置位则气泡永亮不了。
  const st0 = Number(b.status) || 0;
  if ((st0 & FEELR.STATUS_DORM_REST) === 0) {
    b.status = st0 | FEELR.STATUS_DORM_REST;
    pushServantChanges(conn, [{ servant_id: sid, key: CHANGE_ID_STATUS, val: b.status }]);
  }
  saveState();
  conn.sendToc('m_dorm_servant_in_toc', { dorm_id: 1, servants: dormServantList() });
  // 言灵录："将X（X、Y一起）放入协会"的条件判定
  try { require('./moment').checkUnlocks(conn); } catch (e) { /* 言灵录异常不阻塞入住 */ }
  log(`[dorm] 誓灵 ${sid} 入住休息位 ${slot}，当前入住 ${S.dormState.servants.length} 位`);
},
// 誓灵离开休息位：{dorm_id, servant_id}。离位收尾（满足度结清/小惊喜自动入包/清 bit10）见 leaveRestCleanup
m_dorm_servant_out_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const before = S.dormState.servants.length;
  leaveRestCleanup(conn, S.dormState.servants.find(s => Number(s.servant_id) === sid));
  S.dormState.servants = S.dormState.servants.filter(s => s.servant_id !== sid);
  if (S.dormState.servants.length !== before) saveState();
  conn.sendToc('m_dorm_servant_out_toc', { dorm_id: 1, servant_id: sid });
  log(`[dorm] 誓灵 ${sid} 离开休息位（剩余 ${S.dormState.servants.length} 位）`);
},
// 解锁休息位：客户端按 slots+1 逐个请求；兜底回包 dorm_id/slot=0 会让
// updateDormSlot(0,0) 落空 → 点击解锁无反应。
//
// 费用 = CfgDorm.restNeed = {0,0,100,125,150,175}（第 n 项 = 解锁第 n 个休息位的费用），
// 货币是**协会点 = role_scores[4]**——GameConst.SCORE_ASS_POINT=4（新版客户端同名 SCORE_DORM=4），
// 客户端 DormRestPopupPanel 就是拿 `GlobalData.getScore(4) < getRestNeed(slots+1)` 判定按钮能不能点
// （BagMgr.getItemNum(31000009) 也返回同一个积分）。扣费走 L.addScore（内部会推
// m_role_score_change_toc），否则面板上的协会点还是旧值、下一个位置的价格判定也是错的。
m_dorm_slot_unlock_tos(conn, obj) {
  const dormId = 1;
  const slot = Number((obj && obj.slot) || 0); // 新解锁的位数（= 当前 slots+1）
  const need = REST_NEED[slot - 1];
  if (slot < 1 || slot > 6 || need == null) {
    log(`[dorm] 非法休息位请求 slot=${slot}`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // D2：不 return 裸奔，否则客户端弹"网络等待"
    return;
  }
   if (slot <= S.dormState.slots) {
     // 幂等请求不能再次扣费；回当前状态即可让客户端结束 loading。
     conn.sendToc('m_dorm_slot_unlock_toc', { dorm_id: dormId, slot: S.dormState.slots });
     return;
   }
   if (slot > S.dormState.slots + 1) {
     log(`[dorm] 休息位不允许跳位：请求 ${slot}，当前 ${S.dormState.slots}`);
     conn.sendToc('m_common_reply_toc', { proto_id: 0 });
     return;
   }
  if (need > 0) {
    const have = L.getScore(SCORE_ASS_POINT);
    if (have < need) {
      log(`[dorm] 休息位 ${slot} 需 ${need} 协会点，当前 ${have}，拒绝`);
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      return;
    }
    L.addScore(conn, SCORE_ASS_POINT, -need); // 扣协会点（并推 m_role_score_change_toc）
  }
  S.dormState.slots = Math.max(S.dormState.slots, slot);
  saveState();
  // 客户端 updateDormSlot(dorm_id, slot)：detail.slots=slot + 该位置 0（解锁）→ 面板刷新
  conn.sendToc('m_dorm_slot_unlock_toc', { dorm_id: dormId, slot });
  log(`[dorm] 解锁休息位 ${slot}（花费 ${need} 协会点，余 ${L.getScore(SCORE_ASS_POINT)}），当前已解锁 ${S.dormState.slots} 位`);
},
// ==================== 补给站（m_depot_*） ====================
// 打开面板 / 主城四图标点亮的唯一数据源。客户端 DormMgr.initSupply(toc) 会：
//   updateServants(toc.servants)  —— int[] servant_id（**未满级的休息位誓灵**，见 restServantsUnderMax 注释）
//   table.toDic(toc.shelf, "id")  —— 只处理**出现过的** id，逐条 initByPkvt → isUnlock = true
// ⇒ 必须把"已解锁"的货架全发（1 号恒开；2/3 随扩建；4 号花钱解锁），否则图标恒灰。
m_depot_info_tos(conn) {
  shelfDailyReset();
  // 休息位结算（二百七十四）：与货架经验结算同点——补给站发放对象就是休息位誓灵，
  // 打开补给面板/主城四图标时把满足度与收集一并结清
  try { require('./feeling').restSettle(conn); } catch (e) { /* 休息结算异常不阻塞 */ }
  // 结算：把离线期间的经验真正发给休息誓灵（一次算完，避免逐货架推多份 changes）
  const settled = shelfSettleAll(conn);
  const shelf = SUPPLY_SHELVES
    .filter(cfg => shelfUnlocked(cfg.id))
    .map(cfg => {
      const st = shelfState(cfg.id);
      return {
        id: cfg.id,
        goods: Number(st.goods) || 0,
        sup_goods: Number(st.sup_goods) || 0,
        free: Number(st.free) || 0,
        // speed/sup_speed 是**展示用**速率（客户端 getExpOneHour 直接读它算"可供应时间"）
        speed: cfg.normal.speed,
        sup_speed: cfg.advance.speed,
      };
    });
  const servants = restServantsUnderMax().map(b => Number(b.id));
  saveState();
  conn.sendToc('m_depot_info_toc', { bd_id: 0, level: 0, shelf, servants });
  // 结算可能把库存耗尽（供应中→缺货中）——补给面板/主城图标/场景机器点击都会走到这里，
  // 顺手刷新场景售货机气泡（rewardDic[5] 惰性创建，登录链 depotNotify 之前它还不存在也无妨）
  depotNotify(conn);
  log(`[depot] 补给站信息：${shelf.length} 个货架已解锁，休息誓灵 ${servants.length} 位未满级`
    + (settled.consumed > 0 ? `；本次结算发放 ${settled.consumed} 经验（每人 ${settled.perServant}）` : ''));
},
// 购买/补给（DormSupplyBuyPanel.toBuy / DormSupplyItem.onFreeClick）
// tos{shelf_id, type, opt, currency}：
//   type = 1 普通 / 2 高级；opt = 1 买 10 份 / 2 补满；currency 客户端已换算（0 体力 1 协会点 2 水晶）
//   ⚠️ tos 里**没有道具 id**，价格必须服务端按 shelf_id+type 查表（不信客户端）。
//   ★ currency 语义（二百八十三，真机 bc 符号化实证）：DormSupplyBuyPanel.updateItem 给 cost[]
//     **每个条目**生成一对按钮（btnTen21/btnAll21=条目1、btnTen22/btnAll22=条目2，按钮文案就是
//     该条目自己的 num），toBuy 把"玩家点中的那条"的 convertCurrency(cost[idx].id) 发上来
//     ⇒ cost[] 是**互斥的可选货币清单**，不是叠加价！旧实现按 cost[0] 校验 + 逐条全扣：
//     协会点按钮（currency=1）被静默拒（「点了没反应」）、水晶按钮把协会点一起双扣。
//   购买量（份）→ 经验 = ceil(num * 10 * (max-remain) / max)（客户端 getAllCostNums 同式）
// 回包 m_depot_supply_toc{shelf_id, goods, sup_goods, free}：客户端 updateShelfNum + 刷面板 + 刷购买弹窗
m_depot_supply_tos(conn, obj) {
  const shelfId = Number((obj && obj.shelf_id) || 0);
  const type = Number((obj && obj.type) || 0);
  const opt = Number((obj && obj.opt) || 0);
  const currency = Number(obj && obj.currency);
  const reject = (why, tipCode) => {
    log(`[depot] 补给被拒：${why}（shelf=${shelfId} type=${type} opt=${opt} currency=${currency}）`);
    // 余额不足用官方错误码 tips 给反馈（262006 体力不足 / 542006 水晶不足 / 482004 协会点数不足）；
    // 其余（非法参数/配置错）仍走静默 common_reply。D11：被拒不回本协议，否则客户端当成功。
    if (tipCode) conn.sendToc('m_common_tips_toc', { code: tipCode });
    else conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  };
  const cfg = SHELF_BY_ID[shelfId];
  if (!cfg) return reject(`货架 ${shelfId} 不存在`);
  if (!shelfUnlocked(shelfId)) return reject(`货架 ${shelfId}（${cfg.name}）未解锁`);
  if (type !== SHELF_NORMAL && type !== SHELF_ADVANCE) return reject(`type=${type} 非法（必须 1/2）`);
  if (opt !== 1 && opt !== 2) return reject(`opt=${opt} 非法（必须 1 买10份 / 2 补满）`);
  const item = type === SHELF_ADVANCE ? cfg.advance : cfg.normal;
  // 按 currency 选出玩家点中的那条价目（互斥可选，见顶部 currency 语义注释）；无匹配即改包/版本错配
  const entry = (item.cost || []).find(c => currencyOfItem(c.id) === currency);
  if (!entry) {
    return reject(`currency=${currency} 不在 ${cfg.name}·${item.name} 价目 [${(item.cost || []).map(c => c.id).join(',')}] 里`);
  }
  const st = shelfState(shelfId);
  const curRemain = type === SHELF_ADVANCE ? (Number(st.sup_goods) || 0) : (Number(st.goods) || 0);
  if (curRemain >= item.max) return reject(`${cfg.name}·${item.name} 已补充满（${curRemain}/${item.max}）`);
  // ★ 价格/数量模型（与客户端两个按钮严格对应，别自己发明）：
  //   btnTen(opt=1)「补充10%库存」：固定补 max×10% 的经验，按所选条目扣 cost.num
  //   btnAll(opt=2)「补充至最大库存」：补满缺口，按所选条目扣
  //        ceil(cost.num * 10 * (max-remain)/max)   ← DormShelfItemVO.getAllCostNums 原式
  //   ⇒ 单位 units = "补了几个 10%"：opt=1 恒 1；opt=2 = 10*缺口/max
  const space = Math.max(0, item.max - curRemain);
  const units = opt === 1 ? 1 : 10 * space / item.max;
  const addExp = Math.min(space, Math.floor(item.max * 0.1 * units));
  if (addExp <= 0) return reject('折算经验为 0（剩余空间不足）');
  // 扣费：只扣玩家选中的货币条目（其余条目是"另一种付法"，与本次购买无关）
  const cid = Number(entry.id);
  const num = Math.max(1, Math.ceil(Number(entry.num) * units));
  const ccur = currencyOfItem(cid);
  const pays = [];
  if (ccur === CUR_VIT) {
    const V = require('./vit');
    if (V.getVit() < num) return reject(`体力不足（需 ${num}，当前 ${V.getVit()}）`, 262006);
    pays.push({ kind: 'vit', num });
  } else if (ccur === CUR_ASS) {
    if (L.getScore(SCORE_ASS_POINT) < num) return reject(`协会点不足（需 ${num}，当前 ${L.getScore(SCORE_ASS_POINT)}）`, 482004);
    pays.push({ kind: 'ass', num });
  } else if (ccur === CUR_GOLD) {
    const have = (Number(S.roleAsset.gold) || 0) + (Number(S.roleAsset.gold_given) || 0);
    if (have < num) return reject(`水晶不足（需 ${num}，当前 ${have}）`, 542006);
    pays.push({ kind: 'gold', num });
  } else {
    return reject(`货架配置里的货币道具 ${cid} 无对应钱包`);
  }
  // 先扣后发（事务顺序：扣费失败已在上一步拦掉，不会出现"已扣未到货"）
  for (const p of pays) {
    if (p.kind === 'vit') require('./vit').addVit(conn, -p.num);
    else if (p.kind === 'ass') L.addScore(conn, SCORE_ASS_POINT, -p.num);
    else costCrystal(p.num);
  }
  if (pays.some(p => p.kind === 'gold')) pushAssetChange(conn);
  // 入库
  if (type === SHELF_ADVANCE) st.sup_goods = Math.min(item.max, (Number(st.sup_goods) || 0) + addExp);
  else st.goods = Math.min(item.max, (Number(st.goods) || 0) + addExp);
  saveState();
  conn.sendToc('m_depot_supply_toc', {
    shelf_id: shelfId,
    goods: Number(st.goods) || 0,
    sup_goods: Number(st.sup_goods) || 0,
    free: Number(st.free) || 0,
  });
  depotNotify(conn); // 供应中/缺货中气泡（客户端 m_depot_supply_toc 也会自算 val，这里是兜底一致性）
  log(`[depot] 补给 ${cfg.name}·${item.name} +${addExp}（${pays.map(p => p.kind + '-' + p.num).join('+')}）`
    + ` → 库存 ${st.goods}/${cfg.normal.max} + ${st.sup_goods}/${cfg.advance.max}`);
},
// 解锁货架（只有 4 号有 unlockCost=2000 协会点、preUnlock=[2,3]）
// 客户端 m_depot_unlock_shelf_toc → DormMgr.unlockShelf(id) → 刷面板
m_depot_unlock_shelf_tos(conn, obj) {
  const id = Number((obj && obj.id) || 0);
  const cfg = SHELF_BY_ID[id];
  const reject = why => {
    log(`[depot] 解锁货架被拒：${why}（id=${id}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  };
  if (!cfg) return reject(`货架 ${id} 不存在`);
  if (!cfg.unlockCost) return reject(`货架 ${id}（${cfg.name}）是自动解锁/默认开启，不接受购买`);
  if (shelfUnlocked(id)) {
    // 幂等：已解锁就回当前状态（不重复扣费）
    conn.sendToc('m_depot_unlock_shelf_toc', { id });
    return;
  }
  const missing = (cfg.preUnlock || []).filter(x => !shelfUnlocked(x));
  if (missing.length) return reject(`前置货架 [${missing.join(',')}] 未解锁`);
  const cost = Math.max(0, Number(cfg.unlockCost) || 0);
  const have = L.getScore(SCORE_ASS_POINT);
  if (have < cost) return reject(`需 ${cost} 协会点，当前 ${have}`);
  if (cost > 0) L.addScore(conn, SCORE_ASS_POINT, -cost);
  const st = shelfState(id);
  st.unlocked = true;
  saveState();
  conn.sendToc('m_depot_unlock_shelf_toc', { id });
  depotNotify(conn); // 未解锁货架不计入"供应中"，解锁后气泡分母/分子都可能变化
  log(`[depot] 解锁货架 ${id}（${cfg.name}）花费 ${cost} 协会点，余 ${L.getScore(SCORE_ASS_POINT)}`);
},
m_dorm_tourist_detail_tos(conn, obj) {
  // ⚠️ 兜底很危险：defaultFill 发 op_type=0 → 客户端 m_dorm_tourist_detail_toc 落进 else 分支
  //    → openAddFriendPopupPanel()（**错弹"加好友"面板**）。当前 detail.tourists=[] 没有可点对象，
  //    暂时踩不到；但一旦做游客系统就必须同时实现。这里先显式拒绝（客户端静默）。
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
// 誓灵小惊喜领取（主城 MainBubbleItem 气泡 / 宿舍场景点击）：
// 产出由 feeling.restSettle 掷骰进 p_dorm_servant.reward（官方语义：CfgDorm.helpText.collects
// 「在协会中休息的誓灵偶尔还会带来一些小惊喜～繁荣度越高越频繁、越稀有」）。
// 客户端 m_dorm_get_reward_toc 是 `Tips.addTips("领取成功")` —— **到包即弹**（D11）
// ⇒ 只在实际发奖后回；拒绝路径走 common_reply（客户端静默）。
// 发奖分路与派遣领奖同口径（grantCollectReward）；清气泡必须补推 m_dorm_reward_notify_toc{id, reward:[]}
// ——主城气泡圈靠它 dispatch DORM_GET_REWARD 收起，宿舍头顶气泡靠 updateDormServantReward 清空
// （该函数自带 nil 守卫，本会话没拉过 servants 也不崩）。
m_dorm_get_reward_tos(conn, obj) {
  const sid = Number((obj && obj.id) || 0);
  const rec = (S.dormState.servants || []).find(s => Number(s.servant_id) === sid);
  const reject = why => {
    log(`[dorm] 小惊喜领取被拒：${why}（id=${sid}）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  };
  if (!rec) return reject('誓灵不在休息位');
  const reward = Array.isArray(rec.reward) ? rec.reward : [];
  if (!reward.length) return reject('无可领奖励');
  const g = grantCollectReward(conn, reward);
  rec.reward = [];
  saveState();
  conn.sendToc('m_dorm_get_reward_toc', { id: sid, reward: g.items });
  conn.sendToc('m_dorm_reward_notify_toc', { id: sid, reward: [] });
  log(`[dorm] 誓灵小惊喜领取 servant=${sid}：${collectDescribe(g.items)}`
    + `${g.silver ? `（金币入账 ${g.silver}）` : ''}${g.vit ? `（体力 +${g.vit}）` : ''}`);
},
// 陌生人列表（DormVisitPopupPanel.open ← DormPanel.btnVisit）：本地服无其他玩家。
// 客户端 updateVisitPopupPanel(list) 空表安全（列表空，面板能正常开关）。
// 兜底 defaultFill 也是 {list:[]}，这里显式回一份，避免依赖兜底的告警噪音。
m_dorm_stranger_list_tos(conn) {
  conn.sendToc('m_dorm_stranger_list_toc', { list: [] });
},
// ---- 以下两条是**显式拒绝**，不是功能实现 ----
// 理由：兜底回包在这两条上会造成"假成功"或崩溃，比拒绝更糟。
//
// m_dorm_like_tos{target_id}：客户端 m_dorm_like_toc **到包即弹「点赞成功」**（无条件 addTips），
// 然后 updateLike(target_id, num)。本地服没有其他玩家（dorm_list 只有自己），生产不出有意义的
// 点赞数；发默认值 {target_id:0,num:0} 就是"提示成功但状态没变"（D11 类假成功）。
// ⇒ 回 m_common_reply_toc（客户端静默，只有 1 秒等待被复位）。
m_dorm_like_tos(conn) {
  log('[dorm] 点赞：本地服无其他玩家，显式拒绝（避免客户端弹假「点赞成功」）');
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
// m_dorm_unlock_tos{dorm_id}：开"第二间休息室"。本版只有一个协会（dorm_list 恒 1 条），
// 客户端要是拿到 dorm_toc 反而会往 dormList 里塞第二条。而 **兜底** `{dorm:[]}` 会让客户端
// `m_dorm_unlock_toc` 走 updateDormSlot(nil,nil) → getRest(nil)[nil]=0 → `table index is nil` 崩。
// ⇒ 显式拒绝（等真要支持第二间休息室时再实现，代价 CfgDorm.dormLv[2]=100）。
m_dorm_unlock_tos(conn, obj) {
  log(`[dorm] 开第二休息室：本版只有单协会，显式拒绝（dorm_id=${(obj && obj.dorm_id) || 0}）`);
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
  },
  defaultDormFurnitures: defaultDormFurnitures, ensureSpecialFurniture: ensureSpecialFurniture,
  depotNotify: depotNotify, depotNonEmptyShelves: depotNonEmptyShelves,
  dormBuildingLv: dormBuildingLv, dormServantList: dormServantList,
  dormLv: dormLv, HOUSE_MAX_LV: HOUSE_MAX_LV, HOUSE_LEVEL_COST: HOUSE_LEVEL_COST, // 扩建：GM/冒烟共用同一份表
  grantFurniture: grantFurniture, grantFurnitureBatch: grantFurnitureBatch,
  isGrantableFurniture: isGrantableFurniture, ALL_GRANTABLE_FURNITURE_IDS: ALL_GRANTABLE_FURNITURE_IDS,
  UNOBTAINABLE_FURNITURE_IDS: UNOBTAINABLE_FURNITURE_IDS, NON_GRANTABLE_FURNITURE_KINDS: NON_GRANTABLE_FURNITURE_KINDS,
  furnitureProsperity: furnitureProsperity,
  // 补给站 / 时光银行（二百一十六）：GM、冒烟、其它 handler 共用同一份表与结算入口
  SUPPLY_SHELVES: SUPPLY_SHELVES, SHELF_BY_ID: SHELF_BY_ID, SHELF_NORMAL: SHELF_NORMAL, SHELF_ADVANCE: SHELF_ADVANCE,
  shelfUnlocked: shelfUnlocked, shelfState: shelfState, shelfSettleAll: shelfSettleAll, shelfSettle: shelfSettle,
  shelfRemainOf: shelfRemainOf, restServantsUnderMax: restServantsUnderMax,
  BANK_EFFECT: BANK_EFFECT, bankLevel: bankLevel, bankCap: bankCap, bankRate: bankRate,
  bankDeposit: bankDeposit, bankWithdraw: bankWithdraw,
  // state.js:567 的旧档迁移要拿它补初始备货；此前漏导出，解构得到 undefined，
  // Object.assign({}, undefined) = {} —— 空仓库静默保留，玩家一件家具都放不出来。
  DEFAULT_WAREHOUSE: DEFAULT_WAREHOUSE,
  // 派遣（调研-派遣系统.md）：冒烟/探针/GM 共用同一份表与判定入口，
  // 避免"测试自己算一套上限、服务端跑另一套"这类静默分叉。
  DISP: DISP, dispatchCap: dispatchCap, buildingMaxLevel: buildingMaxLevel,
  checkDispatchConds: checkDispatchConds, dispatchVitCost: dispatchVitCost,
  sendCrusadeDetail: sendCrusadeDetail, hasDispatchVoice: hasDispatchVoice,
  // 自律派遣解锁判据（通关主线 3-4）：主城快捷面板"自律派遣"app 图标（role.js m_main_app_*）
  // 与 tab6 的 101 卡片必须同判据，否则图标可点、面板 tab6 空心（D20"卡片空白"同族）。
  autoDispatchUnlocked: autoDispatchUnlocked,
};
