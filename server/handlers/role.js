// 登录/角色/货币/GM/功能解锁（重构自 start.js）
const stateMod = require('../state');
const { S, STARTER_TYPES, saveState } = stateMod;
const ACC = require('../accounts');
const L = require('../lib');
const { log, defaultFill, sendRoleDetail, bagTypeOf, pushGoodsUpdate, pushAssetChange, VALID_ITEM_TYPES, buildOpenFunctions, pushFunctionList, pushServantChanges, CHANGE_ID_EXP, CHANGE_ID_LEVEL, CHANGE_ID_OVERSTEP, TRAIN, grantGoods } = L; // 解构导入，域内裸调用与单文件时代一致
const { pushServantsBrief, makeServantBrief, pushHelperGroup, helperOrderIds } = require('./servant');
const { isEnemyOnlyServantType } = require('../data/servant_types');
const { advanceMissions, playedTheaters } = require('./activity');
const { MAP_CONFIGS } = require('../data/map_configs');
const { THEME_IDS } = require('../data/main_themes');
const { MAIN_APPS, appPredicate } = require('../data/main_app_data');
const { MEDAL_IDS, MEDAL_NAMES, MEDAL_VAL, MEDAL_SLOTS } = require('../data/medal_data');

// 当前已通过 m_auth_key_tos 的连接（多账号：S 是单例，同时只允许一个账号在线）
let activeConn = null;

// 勋章佩戴位转 p_kvi（空位 val=0；有勋章 val=MEDAL_VAL=图标分段，见 data/medal_data.js）
function medalUseKvi() {
  return S.medalState.use.map(id => ({ id, val: id ? MEDAL_VAL : 0 }));
}

// GM 新增誓灵后的客户端宣告：**只推增量，绝不重推全量 brief**。
// 全量 m_servants_brief_toc 会让客户端 ServantMgr.initServantInfo 重建 uv1/uv2 —— 但它
// **不清 uv0（类型计数表）**，随后对每个已存在实例 id 调 addServant，而 addServant 的类型
// 计数是**无条件 +1**（bc asm 实证，ljd 明文把这行丢了；指南 D7①）→ 每推一次全量包，
// 每个类型的计数就再翻一倍，实例列表不变。失衡后任何 fame 推送都会在
// ServantAltarDetailVO.updateRankList 取 getTopLevelServant(type) 空表 `.level` 崩。
// 2026-10-17 azhi 真机：连点 11 次 GM 加誓灵 → 12 次全量 brief → 一拉能源就
// `m_servant_type_fame_update_toc → ServantAltarDetailVO:0: attempt to index a nil value`。
// 增量走 m_servant_update_toc{new, reward_type:1}（客户端只 addServant，不弹获得动画）。
function announceNewServants(conn) {
  if (!conn) return;
  try {
    const ids = require('./servant').pushPendingServants(conn);
    if (ids.length) log(`[GM] 增量宣告新誓灵 ${ids.length} 只（不重推全量 brief，避免类型计数翻倍）`);
  } catch (e) {
    log('!! GM 增量宣告失败：' + e.message);
  }
}

// ============================================================================
// GM 指令框架（2026-10-20 二百零一，方案文档 `GM面板全链路修复方案.md` P0）
//
// 现状：GM 面板 98 个条目里 82 个走聊天通道（DebugModule.sendGM → ChatModule.toChat →
// m_chat_in_channel_tos → 这里按 m21_ 前缀截胡），只有 1 个走 m_role_gm_command_tos。
// 面板发的是**官方命令名**，服务端实现的是**自己起的名字**，两边交集只有 8 条，其余全落到
// 函数末尾那行 `log('[GM] 未实现的指令')` —— 而这行用户永远看不到。
//
// P0 在这一层补三件事（不动各分支实现）：
//   ① 整链 try/catch：任何一条指令抛异常都不再吞掉回包（原来会连 m_common_reply_toc 都发不出去，
//      客户端 ErrorMgr.checkSendBack 等 1 秒就弹"网络较差"）。
//   ② 必有回执：成功/未实现/参数错 → 一律回 m_role_gm_command_toc{msg}，客户端 DebugModule
//      弹 Alert（这是唯一能把结果显示成弹窗的协议，此前服务端从未发过一次）。
//   ③ 面板语义适配：官方名 ↔ 本服实例模型的翻译集中在这里做，分支实现一行不改。
//
// 约定：gmDispatch 保持原有 `return true / false` 语义（12 处既有测试与探针直接调它）；
//       需要自定义回执文案的分支直接 `return { ok, msg }`，包装层原样透传。
// ============================================================================

// 纯改名的别名（参数布局一致）。键=面板发的官方名，值=本服实现名。
const GM_ALIAS = {
  m21_lv: 'm21_role_level',            // 设置角色等级
  m21_astrolabe_exp: 'm21_starexp',    // 增加星盘经验（星盘=星图 astrolabe）
  m21_dream_to: 'm21_dream_barrier',   // 银匙之门通关到第 N 关
  m21_reset_dream: 'm21_dream_reset',  // 重置银匙之门次数
  // 官方配置 ljd 反编译产物带了个多余的 c（字节码里是 m21_reset_copy_times，已按
  // 长度前缀逐字节核对）；两条都收，防止旧客户端/脚本发错名。
  m21_creset_copy_times: 'm21_reset_copy_times',
};

// 回执里用的中文名（覆盖面板 98 条里会落到 gmDispatch 的全部 + 服务端独有条目）
const GM_NAMES = {
  // 别名键也要有中文名，否则回执只会显示原始命令（冒烟 ⑤ 会盯这一条）
  m21_lv: '设置角色等级', m21_astrolabe_exp: '增加星盘经验',
  m21_dream_to: '银匙之门跳关', m21_reset_dream: '重置银匙之门',
  m21_add_servant: '获得誓灵（多种）', m21_add_servant2: '获得誓灵',
  m21_set_helper: '设置看板娘', m21_set_level: '设置誓灵等级', m21_give_exp: '誓灵加经验',
  m21_role_exp: '指挥官加经验', m21_role_level: '设置角色等级', m21_energy_ceil: '誓灵能源上限',
  m21_star: '设置星级', m21_evolution_mats: '补齐进化材料', m21_daily_open: '曜日副本强制全开',
  m21_daily_times: '曜日副本已用次数', m21_daily_reset: '重置曜日副本',
  m21_story_reward_reset: '重置主线首通奖励', m21_double: '双倍次数', m21_pass_chapter: '通关至第 N 章',
  m21_ex_reset: 'EX挑战关自测(0-3|clear)',
  m21_clear_stage: '清空指定关卡通关记录（复测章末解锁）',
  m21_feeling: '设置羁绊', m21_rest: '休息快进N小时', m21_break_mats: '补齐突破材料', m21_goods: '获得道具',
  m21_furnitures: '获得家具', m21_summon_pack: '召唤自测包', m21_affinity_mats: '灵契材料',
  m21_echo: '回响之契（凭神回响货币）',
  m21_summon_reset: '重置召唤状态', m21_equip_pack: '圣器测试包', m21_clear_bag: '清空背包',
  m21_bgold: '设置水晶', m21_silver: '设置金币', m21_vit: '增加体力', m21_vit2: '设置体力',
  m21_starexp: '增加星云点', m21_family_score: '增加结社积分', m21_ass_point: '增加协会点',
  m21_act_give: '活动货币直充', m21_act_claim: '活动任务领取', m21_act_favor: '乐之旅途好感',
  m21_act_favor_reset: '重置好感度', m21_act_reset: '重置活动扩展', m21_sign_reset: '重置签到',
  m21_family_exp: '增加结社经验', m21_lineup: '解锁阵型', m21_ark_science: '设置科研点',
  m21_ark_fuel: '设置燃料', m21_ark_fire: '设置火种', m21_ark_research: '一键满科技',
  m21_ark_reset: '重置方舟', m21_altar_reset: '重置祭坛', m21_handbook_all: '图鉴全解锁',
  m21_dream_times: '银匙之门次数', m21_dream_barrier: '银匙之门跳关', m21_dream_reset: '重置银匙之门',
  m21_skin: '解锁皮肤', m21_guide_reset: '重置引导', m21_account: '查看账号', m21_savefile: '回传存档',
  // 面板官方名（未实现时也要有个中文名）
  m21_function: '开启所有功能', m21_guide: '完成引导', m21_god: '上帝', m21_h: '查询 GM 指令',
  m21_copy_story: '通关副本', m21_mission: '完成任务', m21_activity: '加任务活跃度',
  m21_score: '增加积分', m21_pay: '模拟充值',
  m21_creset_copy_times: '重置挑战/曜日次数', m21_copy_act: '通关活动关卡',
  m21_copy_story_double_buff_reset_all: '重置双倍 buff', m21_test_reward: '测试关卡掉落',
  m21_pass_tower: '无限领域通关', m21_tower_add_recover: '无限领域恢复次数',
  m21_reset_tower: '刷新无限领域天赋', m21_dare_copy: '开启唤灵殿堂', m21_dare_pass: '通关唤灵殿堂',
  m21_dare_season: '唤灵殿堂换期', m21_re_dare: '刷新唤灵殿堂', m21_moments: '言灵录解锁',
  m21_chaos_all: '设置暗噬', m21_pledge: '缔结灵契', m21_pledge_all: '全体缔结灵契',
  m21_cv: '解锁语音', m21_accumulative_sign: '签到 N 天', m21_add_satisfaction: '增加满足度',
  m21_family_reset: '结社每日重置', m21_box: '结社宝箱怪次数', m21_lv2: '1 级升 75 级',
  m21_sgod: '誓灵满配', m21_add_all_servant: '图鉴全誓灵', m21_clean_servant: '分解空闲誓灵',
  m21_boss_ticket: '获得入场券', m21_add_const_login: '星座复刻天数',
  // 面板官方名（语义适配）
  m21_servant_lv: '设置誓灵等级', m21_servant_star: '设置星级', m21_servant_feeling: '设置羁绊',
  m21_servant_exp: '誓灵加经验', m21_energy: '誓灵能源上限', m21_servant_break: '设置突破次数',
};

// 本服端到端没有的玩法：点了要明确说"没这个玩法"，而不是含糊的"未实现"
// （三百一十五：m21_crusade/m21_reset_crusade/m21_time_bank 已随派遣/时光银行落地迁出本表，
//  其余新增四条是"面板有、对应活动/道具本版没有"的如实点名）
const GM_UNAVAILABLE = {
  m21_maze_layer: '金字塔/迷宫', m21_maze_pool: '金字塔/迷宫', m21_maze_t: '金字塔/迷宫',
  m21_maze_tile: '金字塔/迷宫', m21_pscore: '天梯', m21_ladder_season: '天梯',
  m21_mb: '神迹演武', m21_pay: '内购充值',
  m21_create_order_war: '指令战', m21_wdebug: '指令战', m21_fdebug: '战斗调试',
  m21_fattr: '战斗属性面板', m21_vivian: '薇薇安活动',
  m21_copy_act: '活动关卡（高天原复刻等 COPY_ACTIVITY_BOSS 活动未实装）',
  m21_boss_ticket: '入场券（本版客户端无此道具）',
  m21_add_const_login: '星座复刻（对应活动未实装）',
  m21_test_reward: '关卡掉落模拟器（结算链无独立掉落入口，需另立工单）',
};

// 客户端补丁内部调用、弹窗会打断正常操作的指令（仍执行，只是不弹回执）
// m21_set_helper：主页切换看板娘时客户端补丁经聊天通道转发（工作日志一百六十）
const GM_SILENT = new Set(['m21_set_helper']);

// 回执附带的"当前状态"短串（只给看不出变化的那些指令补一句，避免空泛的"✓ 已执行"）
const GM_PROBE = {
  m21_vit: () => { const v = require('./vit'); return `当前 ${v.getVit()}`; },
  m21_vit2: () => { const v = require('./vit'); return `当前 ${v.getVit()}`; },
  m21_bgold: () => `水晶 ${S.roleAsset.gold}`,
  m21_silver: () => `金币 ${S.roleAsset.silver}`,
  m21_role_level: () => `Lv${S.roleAsset.level}`,
  m21_role_exp: () => `Lv${S.roleAsset.level}`,
  m21_goods: () => `背包 ${S.bagGoods.length} 项`,
  m21_add_servant: () => `誓灵 ${S.servants.length} 只`,
  m21_add_servant2: () => `誓灵 ${S.servants.length} 只`,
  m21_clear_bag: () => `背包 ${S.bagGoods.length} 项`,
  m21_star: () => `誓灵 ${S.servants.length} 只`,
};

// GM 指令聊天指令（CfgDebug 定义，格式 m21_xxx=a=b），官方由服务端解释执行
function handleGmCommand(conn, msg) {
  const raw = String(msg || '');
  const head = raw.split('=')[0];
  let out;
  try {
    const translated = GM_ALIAS[head] ? GM_ALIAS[head] + raw.slice(head.length) : raw;
    // P1：新指令先在注册表里找（data/gm_commands.js），找不到再回落旧的 700 行 if 链。
    // 这样新指令天然具备参数校验/异常隔离/统一回执，老分支不用一次性重写。
    const p = translated.split('=');
    out = require('./gm').run(conn, p[0], p, GM_NAMES);
    if (out == null) out = gmDispatch(conn, translated);
  } catch (e) {
    log(`!! [GM] 指令执行异常 ${head}：${e.message}`);
    return { ok: false, msg: `✗ ${GM_NAMES[head] || head} 执行异常\n${String(e.message).slice(0, 100)}` };
  }
  if (out && typeof out === 'object') {
    if (GM_SILENT.has(head)) out.silent = true;
    return out;                       // 分支自带文案
  }
  if (GM_SILENT.has(head)) return { ok: true, silent: true };
  if (out === 'UNIMPLEMENTED') {
    const nm = GM_NAMES[head] || head;
    return { ok: false, msg: GM_UNAVAILABLE[head]
      ? `✗ 本服无此玩法：${GM_UNAVAILABLE[head]}\n（${head}）`
      : `✗ 未实现：${nm}\n（${head}）` };
  }
  if (!out) return { ok: false, msg: `✗ ${GM_NAMES[head] || head} 未执行：参数无效或目标不存在` };
  let extra = '';
  try { extra = GM_PROBE[head] ? GM_PROBE[head]() : ''; } catch (e) { /* 探测失败不影响回执 */ }
  return { ok: true, msg: `✓ ${GM_NAMES[head] || head}${extra ? '：' + extra : ''}` };
}

function gmDispatch(conn, msg) {
  const parts = (msg || '').split('=');
  const cmd = parts[0];
  if (cmd === 'm21_add_servant2' && parts.length >= 2) {
    // m21_add_servant2=<类型ID>=<数量>
    const type = parseInt(parts[1]);
    const count = Math.max(1, parseInt(parts[2]) || 1);
    if (!type) return false;
    let added = 0;
    for (let i = 0; i < count; i++) { const b = makeServantBrief(type); if (b) { if (require("./servant").grantServantBrief(b)) added++; } }
    if (!added) { log(`[GM] 添加誓灵失败 type=${type} ${isEnemyOnlyServantType(type) ? '敌方伪誓灵（官方仅敌人，无持有身份，发放即坏誓灵小屋）' : '非法（不在客户端 CfgServant）'}`); return false; }
    log(`[GM] 添加誓灵 type=${type} x${added}，当前总数=${S.servants.length}`);
    saveState();
    announceNewServants(conn);
    return true;
  }
  if (cmd === 'm21_add_servant' && parts.length >= 2) {
    // m21_add_servant=<类型ID1>=<类型ID2>=... 每样一只
    let n = 0;
    for (const t of parts.slice(1)) {
      const type = parseInt(t);
      if (type) { const b = makeServantBrief(type); if (b) { if (require("./servant").grantServantBrief(b)) n++; } }
    }
    if (!n) return false;
    log(`[GM] 批量添加誓灵 ${n} 只，当前总数=${S.servants.length}`);
    saveState();
    announceNewServants(conn);
    return true;
  }
  if (cmd === 'm21_set_helper' && parts.length >= 2) {
    // m21_set_helper=<誓灵id>：主页切换按钮的通知（客户端补丁经聊天通道转发）
    const id = parseInt(parts[1]);
    if (id && S.servants.some(s => s.id === id)) {
      S.helperState.lastHelper = id;
      saveState();
      // 回 info_toc：解除 1 秒网络等待（checkSendBack）+ 更新 RoleMgr.helper（选择界面"当前"标记）
      conn.sendToc('m_role_profile_info_toc', { intro: S.profileIntro || '', helper: id });
      log(`[helper] 记录看板娘 id=${id}`);
    }
    return true;
  }
  if (cmd === 'm21_set_level' && parts.length >= 2) {
    // m21_set_level=<誓灵id>=<等级>：测试用直升等级（exp 归 0，超上限钳到当前上限）
    const id = parseInt(parts[1]);
    const lv = Math.max(1, parseInt(parts[2]) || 1);
    const b = S.servants.find(s => s.id === id);
    if (!b) { log(`[GM] set_level 未知誓灵 id=${id}`); return true; }
    b.level = Math.min(lv, TRAIN.maxLevelOf(b));
    b.exp = 0;
    saveState();
    pushServantChanges(conn, [{ servant_id: id, key: CHANGE_ID_LEVEL, val: b.level }, { servant_id: id, key: CHANGE_ID_EXP, val: 0 }]);
    log(`[GM] set_level servant=${id} Lv${b.level}`);
    return true;
  }
  if (cmd === 'm21_give_exp' && parts.length >= 2) {
    // m21_give_exp=<经验>：全部誓灵加经验（快速验证升级推送/动画）
    const exp = Math.max(0, parseInt(parts[1]) || 0);
    const changes = [];
    S.servants.forEach(b => {
      const r = TRAIN.applyServantExp(b, exp);
      changes.push({ servant_id: b.id, key: CHANGE_ID_EXP, val: r.exp });
      if (r.level !== r.oldLevel) changes.push({ servant_id: b.id, key: CHANGE_ID_LEVEL, val: r.level });
    });
    if (changes.length) { saveState(); pushServantChanges(conn, changes); }
    log(`[GM] give_exp=${exp} 影响 ${S.servants.length} 只誓灵`);
    return true;
  }
  if (cmd === 'm21_role_exp' && parts.length >= 2) {
    // m21_role_exp=<经验>：指挥官加经验（快速验证等级成长推送/顶栏动画）
    const exp = Math.max(0, parseInt(parts[1]) || 0);
    L.grantRoleExp(conn, exp, 'GM');
    saveState();
    return true;
  }
  if (cmd === 'm21_role_level' && parts.length >= 2) {
    // m21_role_level=<等级>：指挥官直升等级（exp 归 0，钳 1~200）
    const lv = Math.min(L.ROLE_LEVEL.ROLE_MAX_LEVEL, Math.max(1, parseInt(parts[1]) || 1));
    S.roleAsset.level = lv;
    S.roleAsset.exp = 0;
    saveState();
    L.pushRoleLevelup(conn);
    log(`[GM] role_level=Lv${lv}`);
    return true;
  }
  if (cmd === 'm21_energy_ceil' && parts.length >= 2) {
    // m21_energy_ceil=<上限1-15>：全部誓灵全属性能源上限直接置位（免喂养快速验证加点/战斗加成；
    // 点数不动，重进详情生效——detail 每次打开都会重拉）
    const ED = require('../data/energy_data');
    const n = Math.min(ED.ENERGY_CEIL_MAX, Math.max(1, parseInt(parts[1]) || ED.ENERGY_CEIL_MAX));
    S.servants.forEach(b => {
      b.energy_ceils = ED.ENERGY_PROPS.reduce((o, p) => (o[p] = n, o), {});
    });
    saveState();
    log(`[GM] energy_ceil=${n} 影响 ${S.servants.length} 只誓灵（重进详情生效）`);
    return true;
  }
  if (cmd === 'm21_star' && parts.length >= 2) {
    // m21_star=<星级2-5>[=<誓灵id>]：直接置位星级（省略 id = 全部誓灵）。
    // 自测进化面板/进化皮肤/种族值档位；**不推 m_servants_change_toc**（key=4 是绝对赋值，
    // 但誓灵列表 VO 只在重拉 brief 时刷新，改完重进誓灵列表即生效）
    const EV = require('../data/evolution_rules');
    const st = Math.min(EV.MAX_STAR, Math.max(EV.BASE_STAR, parseInt(parts[1]) || EV.BASE_STAR));
    const id = parts.length >= 3 ? parseInt(parts[2]) : 0;
    const targets = id ? S.servants.filter(b => b.id === id) : S.servants;
    if (!targets.length) { log(`[GM] star 未知誓灵 id=${id}`); return true; }
    const FC = require('../data/fight_core');
    targets.forEach(b => { b.star = st; });
    saveState();
    require('./servant').handlers.m_servants_brief_tos(conn); // 重推 brief，列表星星即时刷新
    log(`[GM] star=${st}★（种族值档位 step${FC.stepOfStar(st)}）影响 ${targets.length} 只誓灵`);    return true;
  }
  if (cmd === 'm21_evolution_mats' && parts.length >= 2) {
    // m21_evolution_mats=<誓灵id>：按 CfgServant.starItems 精确补齐该誓灵**当前这一档**进化所缺的材料+金币，
    // 免去手动查 26 种材料 ID（自测进化面板"材料齐了按钮亮"→ 进化成功全链路）
    const EV = require('../data/evolution_rules');
    const id = parseInt(parts[1]);
    const b = S.servants.find(s => s.id === id);
    if (!b) { log(`[GM] evolution_mats 未知誓灵 id=${id}`); return true; }
    const info = EV.upgradeInfoOf(b.type, EV.normStar(b.star));
    if (!info) { log(`[GM] evolution_mats servant=${id} 已满星，无需材料`); return true; }
    const bagNum = t => S.bagGoods.reduce((n, g) => n + (Number(g.type_id) === Number(t) ? Number(g.cur_num) || 0 : 0), 0);
    const changed = [];
    for (const it of info.items) {
      const lack = it.num - bagNum(it.id);
      if (lack > 0) changed.push(...grantGoods(it.id, lack, conn));
    }
    const needLv = EV.starLvOf(EV.normStar(b.star));
    if (Number(b.level) < needLv) { b.level = needLv; b.exp = 0; pushServantChanges(conn, [{ servant_id: id, key: CHANGE_ID_LEVEL, val: b.level }, { servant_id: id, key: CHANGE_ID_EXP, val: 0 }]); }
    if (S.roleAsset.silver < info.cost) { S.roleAsset.silver = info.cost; L.pushAssetChange(conn); }
    saveState();
    if (changed.length) pushGoodsUpdate(conn, changed, 3);
    log(`[GM] evolution_mats servant=${id} type=${b.type} ${EV.normStar(b.star)}★→${EV.normStar(b.star) + 1}★ `
      + `补齐 ${info.items.map(it => `${EV.matName(it.id)}x${it.num}`).join(' ')} 金币${info.cost} 等级门槛Lv${needLv}`);
    return true;
  }
  if (cmd === 'm21_daily_open' && parts.length >= 2) {
    // m21_daily_open=1：强制三章全开（绕过星期轮换自测；=0 恢复按星期）
    const dc = require('./daily_copy');
    const s = dc.st();
    s.forceOpen = (parseInt(parts[1]) || 0) ? 1 : 0;
    saveState();
    dc.pushDailyInfo(conn);
    log(`[GM] 曜日副本强制全开=${s.forceOpen}（今日开放章节 [${dc.openChapters().join(',')}]）`);
    return true;
  }
  if (cmd === 'm21_daily_times' && parts.length >= 2) {
    // m21_daily_times=<已用次数0-2>[=<章号1-3>]：直接置位今日已用次数（省略章号 = 三章一起）
    const dc = require('./daily_copy');
    const DC = require('../data/daily_copy_data');
    const s = dc.st();
    const used = Math.max(0, Math.min(DC.DAILY_TIMES_MAX, parseInt(parts[1]) || 0));
    const chs = parts.length >= 3 ? [parseInt(parts[2])] : Object.keys(DC.DAILY_CHAPTERS).map(Number);
    chs.forEach(c => { if (DC.DAILY_CHAPTERS[c]) s.times[c] = used; });
    saveState();
    dc.pushDailyTimes(conn);
    dc.pushDailyInfo(conn);
    log(`[GM] 曜日副本已用次数=${used}/${DC.DAILY_TIMES_MAX} 章 [${chs.join(',')}]`);
    return true;
  }
  if (cmd === 'm21_daily_reset' && parts.length >= 2) {
    // m21_daily_reset=1：清空曜日副本进度（次数/通关记录/强制全开标记全重置）
    const dc = require('./daily_copy');
    S.dailyCopyState = null;
    dc.st();
    saveState();
    dc.pushDailyTimes(conn);
    dc.pushDailyInfo(conn);
    log('[GM] 曜日副本进度已重置');
    return true;
  }
  if (cmd === 'm21_story_reward_reset' && parts.length >= 2) {
    // m21_story_reward_reset=1：清空首通奖励领取记录（40 关的奖励小图标全部变回可领，自测领取链路）
    const sr = require('./story_reward');
    sr.st().claimed = [];
    saveState();
    sr.pushRedPoint(conn);
    log('[GM] 首通奖励领取记录已清空（重进章节地图生效）');
    return true;
  }
  if (cmd === 'm21_double' && parts.length >= 2) {
    // m21_double=<持有次数0-10>[=<今日已购买次数>]：直接置位双倍次数（免花体力自测双倍结算）
    const sr = require('./story_reward');
    const SRD = require('../data/story_reward_data');
    const s = sr.st();
    s.doubleTimes = Math.max(0, Math.min(SRD.DOUBLE_MAX_TIMES, parseInt(parts[1]) || 0));
    if (parts.length >= 3) s.buyUsed = Math.max(0, Math.min(SRD.DOUBLE_MAX_TIMES, parseInt(parts[2]) || 0));
    if (s.doubleTimes === 0) s.switchOn = 0;
    saveState();
    sr.pushDoubleInfo(conn);
    log(`[GM] 双倍持有次数=${s.doubleTimes}/${SRD.DOUBLE_MAX_TIMES}，今日剩余可购买=${sr.remainBuyTimes()}`
      + `（功能${sr.doubleUnlocked() ? '已' : '未'}开启：需通关 6-4，当前章 ${sr.curChapter()}）`);
    return true;
  }
  if (cmd === 'm21_pass_chapter' && parts.length >= 2) {
    // m21_pass_chapter=<章号1-10>：把第 1~N 章全部关卡标记为已通关（幂等）。
    // 用途：双倍功能要"通关主线6-4"才开（客户端 CopyMainLineView 在 curChapter<7 时直接隐藏开关，
    // 光靠服务端放行也点不到），自测双倍/首通奖励/章节解锁链时用这条跳进度。
    // **会真实改写关卡进度并连带解锁功能/阵型**，只在自测时用。
    const upto = Math.max(1, Math.min(10, parseInt(parts[1]) || 1));
    let n = 0;
    for (let ch = 1; ch <= upto; ch++) {
      for (const st of [1, 2, 3, 4]) {
        const bid = 1000000 + ch * 10000 + st * 100;
        const cfg = MAP_CONFIGS[bid];
        if (!cfg) continue;
        const prog = L.progressOf(bid);
        if (!prog.cleared) prog.cleared = [];
        if (!prog.cleared.includes(cfg.bossPoint)) { prog.cleared.push(cfg.bossPoint); n++; }
      }
    }
    saveState();
    pushFunctionList(conn);
    const sr = require('./story_reward');
    sr.pushRedPoint(conn);
    sr.pushDoubleInfo(conn);
    require('./servant').pushLineupInfo(conn);
    log(`[GM] 标记通关至第 ${upto} 章（新增 ${n} 关）→ 当前章 ${sr.curChapter()}，`
      + `双倍${sr.doubleUnlocked() ? '已' : '未'}开启，功能 [${L.buildOpenFunctions().join(',')}]`);
    return true;
  }
  if (cmd === 'm21_ex_reset' && parts.length >= 2) {
    // m21_ex_reset=<used|clear>：EX 挑战关自测 —— 设每日次数(0~EX_COPY_MAX_TIMES)或 clear=清空 EX 进度
    //（次数+全部 EX 通关/击败记录）。上限随 EX_COPY_MAX_TIMES 走（本服已扩到 10，硬编码 3 会把 >3 的设值静默钳回）。
    const MF = require('./map_fight');
    const arg = parts[1];
    if (arg === 'clear') {
      for (const exId of Object.values(MF.EX_BY_NORMAL)) { // EX_BY_NORMAL: normalId → exId
        delete S.mapProgress.maps[String(exId)];
      }
      S.exState = null;
      saveState();
      log('[GM] EX 进度已清空（14 关 cleared/defeated/shadowDefeated + 每日次数）');
    } else {
      const used = Math.max(0, Math.min(MF.EX_COPY_MAX_TIMES, parseInt(arg) || 0));
      MF.exDaily().used = used;
      MF.exDaily().day = new Date().toISOString().slice(0, 10);
      saveState();
      MF.exDailyLoginPush(conn);
      log(`[GM] EX 每日次数 → ${used}/${MF.EX_COPY_MAX_TIMES}（剩余 ${MF.exRemainTimes()}）`);
    }
    return true;
  }
  if (cmd === 'm21_clear_stage' && parts.length >= 2) {
    // m21_clear_stage=<barrierId|关名如1-4>：清空该关的通关/击败记录（复测"章末首通解锁下一章"用，
    // 二百三十六）。清 1-4 后真打一遍 → 结算面板关闭 → 应自动回章节页并落在第 2 章。
    // ⚠️ 只清进度，不动已获得的掉落誓灵/首通奖励领取记录。
    let bid = 0;
    if (/^[1-9]?[0-9]-[1-4]$/.test(parts[1])) {
      const [c, s] = parts[1].split('-').map(Number);
      bid = 1000000 + c * 10000 + s * 100;
    } else {
      bid = parseInt(parts[1]) || 0;
    }
    const cfg = MAP_CONFIGS[bid];
    if (!cfg || !cfg.monsterChain || !cfg.monsterChain.length) {
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      log(`[GM] m21_clear_stage: 无效主线关卡 ${parts[1]}`);
      return true;
    }
    const prog = L.progressOf(bid);
    prog.cleared = [];
    prog.defeated = [];
    saveState();
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    log(`[GM] 已清空 ${bid} 的通关与击败记录 → 可复测章末首通解锁（二百三十六）`);
    return true;
  }
  if (cmd === 'm21_feeling' && parts.length >= 2) {
    // m21_feeling=<羁绊值0-100>[=<誓灵id>]：置位羁绊值（省略 id = 全部誓灵）。
    // 羁绊（好感）系统本身未实现，但**界限突破（5 突之后）客户端硬性要求羁绊>=100**
    // （ServantConfigVO.isCanDoOverstepMission，官方错误码 173011），不给就永远突不过去
    const v = Math.max(0, Math.min(100, parseInt(parts[1]) || 0));
    const id = parts.length >= 3 ? parseInt(parts[2]) : 0;
    const targets = id ? S.servants.filter(b => b.id === id) : S.servants;
    if (!targets.length) { log(`[GM] feeling 未知誓灵 id=${id}`); return true; }
    const FR = require('../data/feeling_rules');
    const fm = require('./feeling');
    const now = Math.floor(Date.now() / 1000);
    targets.forEach(b => {
      b.feeling = Math.min(v, FR.maxFeelingOf(b));
      b.satisfaction = 0;
      if (!Array.isArray(b.feeling_record)) b.feeling_record = [];
      // 里程碑时间戳补齐：不补的话羁绊面板"相处/相知"那两格显示不出日期
      for (const ms of require('../data/feeling_data').RECORD_MILESTONES) {
        if (b.feeling >= ms && !b.feeling_record.some(r => Number(r.id) === ms)) b.feeling_record.push({ id: ms, val: now });
      }
    });
    saveState();
    fm.pushFeelingChanges(conn, targets);
    log(`[GM] feeling=${v} 影响 ${targets.length} 只誓灵（心情「${FR.moodOf(v)}」；`
      + `界限突破前置：星5 + 羁绊100 + Lv100；灵契前置：羁绊100 + 道具 ${require('../data/feeling_data').PROPOSAL_ITEM}）`);
    return true;
  }
  if (cmd === 'm21_rest' && parts.length >= 2) {
    // m21_rest=<小时>：把全部休息位誓灵的 since/collectAt 锚点倒拨 N 小时后立即结算——
    // 验证"基建放置自动上涨"（满足度增速 + 誓灵收集）用。结算产生的满足度/收集奖励照常推送。
    const hours = Math.max(0, parseFloat(parts[1]) || 0);
    const recs = (S.dormState.servants || []);
    if (!recs.length) { log('[GM] rest：没有誓灵在休息位（先在协会入住）'); return true; }
    const back = Math.round(hours * 3600);
    for (const rec of recs) {
      if (Number(rec.since) > 0) rec.since = Math.max(0, Number(rec.since) - back);
      if (Number(rec.collectAt) > 0) rec.collectAt = Math.max(0, Number(rec.collectAt) - back);
    }
    saveState();
    const r = require('./feeling').restSettle(conn);
    log(`[GM] rest 快进 ${hours}h（${recs.length} 只）：满足度 ${r.touched} 只、收集 ${r.notified} 只${r.detail.length ? ' → ' + r.detail.join(' ') : ''}`);
    return true;
  }
  if (cmd === 'm21_break_mats' && parts.length >= 2) {
    // m21_break_mats=<誓灵id>：按 CfgServant.breakMaterials 精确补齐该誓灵**当前这一档**界限突破所缺材料+金币
    const BK = require('../data/break_data');
    const id = parseInt(parts[1]);
    const b = S.servants.find(s => s.id === id);
    if (!b) { log(`[GM] break_mats 未知誓灵 id=${id}`); return true; }
    const step = Number(b.overstep) || 0;
    if (step < BK.NORMAL_OVERSTEP) { log(`[GM] break_mats servant=${id} 还在前 5 突（吃誓灵不吃材料），overstep=${step}`); return true; }
    const tier = BK.BREAK_MATERIALS[step - BK.NORMAL_OVERSTEP] || [];
    if (!tier.length) { log(`[GM] break_mats servant=${id} 已突破满`); return true; }
    const bagNum = t => S.bagGoods.reduce((n, g) => n + (Number(g.type_id) === Number(t) ? Number(g.cur_num) || 0 : 0), 0);
    const changed = [];
    // 客户端按钮判定是 `有 - 需 > 0`（严格大于，官方 off-by-one）→ 多补 1 个才点得亮
    for (const it of tier) {
      const lack = it.num + 1 - bagNum(it.id);
      if (lack > 0) changed.push(...grantGoods(it.id, lack, conn));
    }
    const cost = (BK.BREAKS[Math.floor(Number(b.type) / 10000) % 10] || BK.BREAKS[4]).costs[step] || 0;
    if (S.roleAsset.silver < cost) { S.roleAsset.silver = cost; L.pushAssetChange(conn); }
    saveState();
    if (changed.length) pushGoodsUpdate(conn, changed, 3);
    log(`[GM] break_mats servant=${id} ${step}→${step + 1} 突 补齐 `
      + tier.map(it => `${BK.MAT_NAMES[String(it.id)] || it.id}x${it.num}`).join(' ') + ` 金币${cost}`);
    return true;
  }
  // 面板「背包」页「提升背包/誓灵格子上限500」（二百三十）：官方按钮发 100×3 个扩容道具
  // （50000000 圣器/50000001 材料/50000002 小屋），但 CfgItems 三者 link=0 ⇒ 客户端
  // BaseItemVO.canUse=false，「使用」按钮永不出现，道具是死物。按精确签名截胡为直接扩容
  // （材料/圣器/核心/小屋各 +500），不发道具；其余 m21_goods 签名照旧走下方通用发放。
  if (msg === 'm21_goods=50000000=100=50000001=100=50000002=100') {
    return { ok: true, msg: '✓ 提升背包/誓灵格子上限：' + require('./vit').applyPanelExpand500(conn) };
  }
  if (cmd === 'm21_goods' && parts.length >= 3) {
    // m21_goods=<type_id>=<数量>[=<type_id>=<数量>...]（CfgDebug"获得道具"，支持多对连发）
    // 圣器/核心（CfgItems canPile=false）按实例各发一个，其余按 type_id 堆叠
    const changed = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const typeId = parseInt(parts[i]);
      const num = parseInt(parts[i + 1]);
      if (!typeId || !num) continue;
      if (VALID_ITEM_TYPES.size && !VALID_ITEM_TYPES.has(typeId)) {
        log(`[GM] 跳过未知物品 type_id=${typeId}（CfgItems 无此配置，下发会让客户端 getItemVO 崩）`);
        continue;
      }
      changed.push(...grantGoods(typeId, num, conn));
    }
    if (changed.length) {
      saveState();
      pushGoodsUpdate(conn, changed, 3); // UPDATE：入包/改数（客户端 updateItem 不存在则 addItem）
      log(`[GM] 添加物品 ${changed.map(g => `${g.type_id}${g.cur_num > 1 ? 'x' + g.cur_num : '#' + g.id}`).join(' ')}，背包共 ${S.bagGoods.length} 项`);
    }
    return true;
  }
  if (cmd === 'm21_summon_pack' && parts.length >= 2) {
    // m21_summon_pack=<约定之契数量>[=<友情点>]：召唤自测包（约定之契 + 可选友情点；
    // 另有 m21_affinity_mats 供灵契召唤）。约定之契 31000004 是 CfgItems 白名单内道具。
    const tickets = Math.max(0, parseInt(parts[1]) || 0);
    const friend = parts.length >= 3 ? Math.max(0, parseInt(parts[2]) || 0) : 0;
    const changed = [];
    if (tickets > 0) changed.push(...grantGoods(31000004, tickets, conn));
    if (changed.length) { saveState(); pushGoodsUpdate(conn, changed, 3); }
    if (friend > 0) { L.addScore(conn, 2, friend); saveState(); }
    log(`[GM] summon_pack 约定之契×${tickets} 友情点+${friend}`);
    return true;
  }
  if (cmd === 'm21_affinity_mats' && parts.length >= 2) {
    // m21_affinity_mats=<n>：灵契召唤材料（score 15 理智八面体 / score 17 信仰勋章）各 +n。
    // 官方出处是活动副本（本服未实现活动线），先给 GM 口子让灵契召唤可测。
    const n = Math.max(0, parseInt(parts[1]) || 0);
    L.addScore(conn, 15, n);
    L.addScore(conn, 17, n);
    saveState();
    log(`[GM] affinity_mats score15/17 各 +${n}`);
    return true;
  }
  if (cmd === 'm21_echo' && parts.length >= 2) {
    // m21_echo=<n>：回响之契（role_scores 28，凭神回响货币）直充。
    // 正路来源是誓约破除 UR（分解 +100，见 servant.js m_servant_decompose_tos），
    // GM 口子用于免去"先抽再拆"的自测成本。
    const n = Math.max(0, parseInt(parts[1]) || 0);
    const ECHO = require('../data/echo_shop_data');
    L.addScore(conn, ECHO.SCORE_ID, n);
    saveState();
    log(`[GM] echo 回响之契 +${n} → 余 ${L.getScore(ECHO.SCORE_ID)}`);
    return true;
  }
  if (cmd === 'm21_summon_reset' && parts.length >= 2) {
    // m21_summon_reset=1：清空召唤状态（累计/每日抽数、保底计数、关闭标记、灵契兑换记录全重置）
    const SS = require('./summon');
    S.summonState = null;
    SS.handlers.m_role_summon_info_tos(conn); // 重建并立即回推卡池列表
    saveState();
    log('[GM] summon_reset 全部召唤状态已重置');
    return true;
  }
  if (cmd === 'm21_equip_pack' && parts.length >= 2) {
    // m21_equip_pack=1：圣器/能力核心测试包（2 圣器 + 6 属性最高色核心各 1 + 核心晶组升级材料）
    const changed = [];
    for (const [typeId, num] of [[10001001, 2], [19100003, 1], [19200003, 1], [19300003, 1], [19400003, 1], [19500003, 1], [19600003, 1], [27000000, 50], [27000001, 30], [27000002, 20]]) {
      changed.push(...grantGoods(typeId, num, conn));
    }
    saveState();
    pushGoodsUpdate(conn, changed, 3);
    log(`[GM] 装备测试包：圣器x2 + 全属性核心(色5)x6 + 升级材料（背包共 ${S.bagGoods.length} 项）`);
    return true;
  }
  if (cmd === 'm21_clear_bag') {
    if (S.bagGoods.length) {
      const removed = S.bagGoods.slice();
      S.bagGoods = [];
      // 装备态引用物品 gid，清包必须同步清圣器/核心装备（否则 detail 下发悬空 gid）
      S.servants.forEach(b => { b.relic_gid = 0; b.cores = {}; });
      saveState();
      pushGoodsUpdate(conn, removed, 2); // DEL：客户端 delGoods 移除
    }
    log('[GM] 清空背包');
    return true;
  }
  if (cmd === 'm21_bgold' && parts.length >= 2) {
    // 设置水晶（CfgDebug"设置水晶"）：gold=总量，gold_given=赠送部分（显示=两者之和，
    // 消耗客户端先扣赠送）——全额设为赠送
    S.roleAsset.gold = S.roleAsset.gold_given = Math.max(0, parseInt(parts[1]) || 0);
    saveState();
    pushAssetChange(conn);
    log(`[GM] 设置水晶 ${S.roleAsset.gold}`);
    return true;
  }
  if (cmd === 'm21_silver' && parts.length >= 2) {
    S.roleAsset.silver = Math.max(0, parseInt(parts[1]) || 0);
    saveState();
    pushAssetChange(conn);
    log(`[GM] 设置金币 ${S.roleAsset.silver}`);
    return true;
  }
  // m21_vit / m21_vit2 语义对调（二百零一）：面板「增加体力」发 m21_vit、「设置体力」发 m21_vit2，
  // 原实现只有 m21_vit 且是**覆盖写**——面板上"增加 5000"把体力从 7000 变成 5000，越点越少。
  // 现在：m21_vit=累加（走 vit.addVit，超上限由客户端 limit 提示）、m21_vit2=覆盖写。
  // 老脚本里"m21_vit=1000 复位"要改用 m21_vit2=1000。
  if (cmd === 'm21_vit' && parts.length >= 2) {
    // m21_vit=<数量>：增加体力（面板「增加体力」；负数为扣除）
    const vit = require('./vit');
    const n = parseInt(parts[1]) || 0;
    vit.addVit(conn, n);
    vit.pushLimit(conn);
    log(`[GM] 增加体力 ${n >= 0 ? '+' : ''}${n} → ${vit.getVit()}`);
    return { ok: true, msg: `✓ 增加体力 ${n >= 0 ? '+' : ''}${n}：当前 ${vit.getVit()}` };
  }
  if (cmd === 'm21_vit2' && parts.length >= 2) {
    // m21_vit2=<数量>：设置体力为指定值（面板「设置体力」）
    const vit = require('./vit');
    vit.setVit(parseInt(parts[1]) || 0);
    saveState();
    vit.pushVit(conn);
    vit.pushLimit(conn);
    log(`[GM] 设置体力 ${vit.getVit()}`);
    return { ok: true, msg: `✓ 设置体力：当前 ${vit.getVit()}` };
  }
  if (cmd === 'm21_starexp' && parts.length >= 2) {
    // m21_starexp=<数量>：加星云点（战斗转化 1/750 太慢，真机自测星图升级/福袋/魔术箱用）
    const n = parseInt(parts[1]) || 0;
    if (n > 0) {
      const g = require('./grow');
      g.starLv(1); // 触发 growState 懒初始化
      S.growState.exp += n;
      S.growState.weekExp += n;
      saveState();
      g.pushAstrolabeInfo(conn);
      log(`[GM] 星云点 +${n}（余 ${S.growState.exp}）`);
    }
    return true;
  }
  if (cmd === 'm21_family_score' && parts.length >= 2) {
    // m21_family_score=<数量>：加结社积分（本周贡献），用于自测结社商店兑换
    const n = parseInt(parts[1]) || 0;
    L.addScore(conn, 8, n);
    saveState();
    log(`[GM] 结社积分 +${n} → ${L.getScore(8)}`);
    return true;
  }
  if (cmd === 'm21_ass_point' && parts.length >= 2) {
    // m21_ass_point=<数量>：加协会点（role_scores[4]，休息位解锁/家具制造货币）
    const n = parseInt(parts[1]) || 0;
    L.addScore(conn, 4, n);
    saveState();
    log(`[GM] 协会点 +${n} → ${L.getScore(4)}`);
    return true;
  }
  if (cmd === 'm21_act_give' && parts.length >= 3) {
    // m21_act_give=<货币key>=<数量>：活动扩展货币直充（choco巧克力/cookie曲奇/lingqiao灵巧/sock圣诞袜/
    // box礼盒/snow雪球/fire灵魂之火/ticket应援券/verse诗文断章/build建造点/choco2情人节/lunch便当/
    // wushan瑶草/meteor陨铁/trust信赖）
    const ok = require('./act_extra').gmGive(conn, parts[1], parseInt(parts[2]) || 0);
    return ok;
  }
  if (cmd === 'm21_act_claim' && parts.length >= 3) {
    // m21_act_claim=<actId>=<任务id>：绕过客户端腐坏渲染直发活动任务领取（小千日记 1361：15=最终奖；乐之旅途 1053）。
    // 走与面板完全相同的校验/发奖/推送链。
    const actId = parseInt(parts[1]) || 0;
    if (actId === 1053) {
      const act = require('./activity');
      const st = act.getFavorState();
      if (parts[2] === 'all') {
        for (let i = 1; i <= 10; i++) {
          if (!st.claimed.includes(i)) {
            const rw = act.LTY_FAVOR_REWARDS[i];
            if (rw) act.grantRewardItems(conn, [rw], { persist: false });
            st.claimed.push(i);
          }
        }
        st.favor = 100;
        saveState();
        conn.sendToc('m_act_favor_score_toc', { act_id: 1053, favor: 100 });
        log('[GM] 乐之旅途好感度任务一键全领');
      } else {
        const mid = parseInt(parts[2]) || 0;
        if (mid >= 1 && mid <= 10 && !st.claimed.includes(mid)) {
          const rw = act.LTY_FAVOR_REWARDS[mid];
          if (rw) act.grantRewardItems(conn, [rw], { persist: false });
          st.claimed.push(mid);
          st.favor = act.getFavorScore(st);
          saveState();
          conn.sendToc('m_act_favor_score_toc', { act_id: 1053, favor: st.favor });
          conn.sendToc('m_act_favor_get_toc', { act_id: 1053, id: mid });
          log(`[GM] 乐之旅途领取任务 id=${mid}, favor=${st.favor}`);
        }
      }
      return true;
    }
    require('./act_extra').handlers.m_get_act_mission_reward_tos(conn, { act_id: actId, id: parseInt(parts[2]) || 0 });
    return true;
  }
  if (cmd === 'm21_act_favor' && parts.length >= 2) {
    // m21_act_favor=<num|all>：直接调整乐之旅途好感度
    const act = require('./activity');
    const st = act.getFavorState();
    if (parts[1] === 'all' || parts[1] === '100') {
      for (let i = 1; i <= 10; i++) {
        if (!st.claimed.includes(i)) {
          const rw = act.LTY_FAVOR_REWARDS[i];
          if (rw) act.grantRewardItems(conn, [rw], { persist: false });
          st.claimed.push(i);
        }
      }
      st.favor = 100;
      saveState();
      conn.sendToc('m_act_favor_score_toc', { act_id: 1053, favor: 100 });
      log('[GM] 乐之旅途好感度全满且已领全奖励（含专属圣器）');
    } else {
      const num = parseInt(parts[1]) || 0;
      st.favor = Math.min(100, Math.max(0, num));
      for (let i = 1; i <= 9; i++) {
        if (!st.counters) st.counters = {};
        st.counters[i] = 999;
      }
      saveState();
      conn.sendToc('m_act_favor_score_toc', { act_id: 1053, favor: st.favor });
      log(`[GM] 乐之旅途好感度调整为: ${st.favor}`);
    }
    return true;
  }
  if (cmd === 'm21_act_favor_reset') {
    S.actFavorState = { favor: 0, claimed: [], is_helper: 0, counters: {} };
    saveState();
    conn.sendToc('m_act_favor_score_toc', { act_id: 1053, favor: 0 });
    log('[GM] 乐之旅途好感度已重置');
    return true;
  }
  if (cmd === 'm21_act_reset' && parts.length >= 1) {
    // m21_act_reset：清空活动扩展全部状态（重新体验各活动进度）
    require('./act_extra').actReset(conn);
    return true;
  }
  if (cmd === 'm21_sign_reset' && parts.length >= 1) {
    // m21_sign_reset：清空每日签到状态（listId 归零 → 下次开面板按当月重开周期，可重签今天）
    S.signState = { listId: 0, days: 0, lastDay: '' };
    saveState();
    log('[GM] 每日签到状态已重置');
    return true;
  }
  if (cmd === 'm21_family_exp' && parts.length >= 2) {
    // m21_family_exp=<数量>：加结社经验（自测升级/成员上限）
    const n = parseInt(parts[1]) || 0;
    const fam = require('./family');
    fam.addFamilyExp(n);
    saveState();
    fam.pushFamilyInfo(conn);
    log(`[GM] 结社经验 +${n} → Lv${S.familyState.lv} exp${S.familyState.exp}`);
    return true;
  }
  if (cmd === 'm21_lineup' && parts.length >= 2) {
    // m21_lineup=<阵型id 1-6>：强制解锁指定阵型（自测未通关关卡的阵型）；m21_lineup=0 清除全部强制解锁
    const id = parseInt(parts[1]) || 0;
    const sv = require('./servant');
    if (!S.lineupState) S.lineupState = { touched: [], forced: [], synced: [] };
    if (!S.lineupState.forced) S.lineupState.forced = [];
    if (id === 0) {
      S.lineupState.forced = [];
    } else if (id >= 1 && id <= 6 && !S.lineupState.forced.includes(id)) {
      S.lineupState.forced.push(id);
    }
    saveState();
    sv.pushLineupInfo(conn);
    log(`[GM] 阵型强制解锁: [${S.lineupState.forced.join(',') || '无'}]，当前解锁集 [${sv.unlockedLineups().join(',')}]`);
    return true;
  }
  if (cmd === 'm21_ark_science' && parts.length >= 2) {
    // m21_ark_science=<数量>：设置科研点（自测研发）
    require('./ark').st();
    L.addScore(conn, 2138, (parseInt(parts[1]) || 0) - L.getScore(2138));
    saveState();
    log(`[GM] 科研点 → ${L.getScore(2138)}`);
    return true;
  }
  if (cmd === 'm21_ark_fuel' && parts.length >= 2) {
    // m21_ark_fuel=<数量>：设置燃料（自测跃迁）
    const ark = require('./ark');
    ark.st();
    L.addScore(conn, 2140, (parseInt(parts[1]) || 0) - L.getScore(2140));
    ark.pushFuelDetail(conn);
    saveState();
    log(`[GM] 燃料 → ${L.getScore(2140)}`);
    return true;
  }
  if (cmd === 'm21_ark_fire' && parts.length >= 2) {
    // m21_ark_fire=<数量>：设置火种（自测火种换燃料）
    require('./ark').st();
    L.addScore(conn, 2139, (parseInt(parts[1]) || 0) - L.getScore(2139));
    saveState();
    log(`[GM] 火种 → ${L.getScore(2139)}`);
    return true;
  }
  if (cmd === 'm21_ark_research' && parts.length >= 2) {
    // m21_ark_research=1：一键完成全部不可重复科技（自测满科技加成/指令卡）；重复科技留正常研发
    const ark = require('./ark');
    const s = ark.st();
    let added = 0;
    for (const sci of require('../data/ark_data').SCIENCES) {
      if (sci.type === 3) continue; // 重复科技（火种/超物质/箱子）保留正常循环
      if (s.scienceDone.includes(sci.id)) continue;
      s.scienceDone.push(sci.id);
      added++;
    }
    s.queue = [];
    saveState();
    ark.pushFuelDetail(conn);
    ark.pushTeamInfo(conn);
    ark.pushScienceInfo(conn);
    log(`[GM] 天空方舟一键研发 +${added}（燃料 ${ark.fuelCeil()} 上限 +${ark.fuelVel()}/h，队容量 ${ark.teamCap()}，扫描 Lv${ark.scannerLv()}）`);
    return true;
  }
  if (cmd === 'm21_ark_reset' && parts.length >= 2) {
    // m21_ark_reset=1：清空方舟进度（科研/卡/队/地图重置，自测全链路）
    S.arkState = null;
    saveState();
    log('[GM] 天空方舟进度已清空');
    return true;
  }
  if (cmd === 'm21_altar_reset' && parts.length >= 2) {
    // m21_altar_reset=1：清空祭坛进度（解锁阵营/供奉位/供奉全重置，自测全链路；重登生效）
    S.altarState = null;
    saveState();
    log('[GM] 祭坛进度已清空');
    return true;
  }
  if (cmd === 'm21_handbook_all' && parts.length >= 2) {
    // m21_handbook_all=1：解锁全部图鉴条目（正式/联动/狂化；重开图鉴列表生效）
    const hb = require('./handbook');
    let n = 0;
    for (const h of require('../data/handbook_data').HANDBOOKS) {
      if (hb.onServantObtained(h.servantType)) n++;
    }
    saveState();
    log(`[GM] 图鉴全解锁：新增 ${n} 条`);
    return true;
  }
  // ---- 银匙之门（幻梦战）自测 ----
  if (cmd === 'm21_dream_times' && parts.length >= 2) {
    // m21_dream_times=<次数>：设置今日剩余挑战次数（免等每日重置）
    const dm = require('./dream');
    const s = dm.st();
    s.dailyLeft = Math.max(0, parseInt(parts[1]) || 0);
    saveState();
    dm.pushInfo(conn);
    log(`[GM] 银匙之门今日挑战次数 → ${s.dailyLeft}`);
    return true;
  }
  if (cmd === 'm21_dream_barrier' && parts.length >= 2) {
    // m21_dream_barrier=<关号1-130>[=<历史最深>]：直接跳到指定关（自测深层敌阵/特殊机制/回合上限）
    const dm = require('./dream');
    const DR = require('../data/dream_rules');
    const s = dm.st();
    const n = Math.min(DR.MAX_BARRIER, Math.max(1, parseInt(parts[1]) || 1));
    s.now = n;
    s.max = Math.max(s.max, parts.length >= 3 ? (parseInt(parts[2]) || 0) : n - 1);
    s.isFight = 1;
    s.failTimes = 0;
    saveState();
    dm.pushInfo(conn);
    log(`[GM] 银匙之门进度 → 第${n}关（历史最深 ${s.max}，回合上限 ${DR.maxRoundOf(n)}`
      + `${DR.effectTipsOf(n).length ? '，机制 ' + DR.effectTipsOf(n).join(' / ') : ''}）`);
    return true;
  }
  // m21_dream_reset 已迁入注册表（data/gm_commands.js，三百一十五）：面板按钮「重置银匙之门
  // 次数」裸发无参数，旧分支 `parts.length >= 2` 永不命中 → UNIMPLEMENTED 弹「未实现」。
  // 注册表版兼容两种形态：裸发=今日次数回满（面板语义），=1=进度全清（旧自测语义）。
  if (cmd === 'm21_skin' && parts.length >= 2) {
    // m21_skin=<皮肤ID>：解锁任意皮肤（含灵契皮肤，自测皮肤/灵契图鉴）
    const skinId = parseInt(parts[1]);
    if (!skinId) return false;
    if (!S.skinState) S.skinState = { owned: [], l2dOwned: [] };
    if (!Array.isArray(S.skinState.owned)) S.skinState.owned = [];
    if (!Array.isArray(S.skinState.l2dOwned)) S.skinState.l2dOwned = [];
    const hadSkinBefore = S.skinState.owned.includes(skinId);
    if (!hadSkinBefore) S.skinState.owned.push(skinId);
    const cfg = require('../skin_config.json');
    const hasLive2d = (cfg.live2dSkins || []).includes(skinId);
    if (hasLive2d && !S.skinState.l2dOwned.includes(skinId)) S.skinState.l2dOwned.push(skinId);
    const hb = require('./handbook');
    if (hb.onSkinObtained(skinId)) hb.pushSkinRedPoints(conn);
    saveState();
    const gainServant = require('./servant').skinGainServantFlag(skinId, hadSkinBefore);
    conn.sendToc('m_servant_shop_active_skin_toc', { skin_type_id: skinId, gain_live: hasLive2d ? 2 : 0, gain_servant: gainServant });
    log(`[GM] 解锁皮肤 ${skinId}（gain_live=${hasLive2d ? 2 : 0}, gain_servant=${gainServant}）`);
    return true;
  }
  if (cmd === 'm21_guide_reset' && parts.length >= 2) {
    // m21_guide_reset=1：把引导进度重置为"全部未完成"（新档口径，客户端重登后从开场视频起手
    // 重跑新手链）。只清引导状态不动誓灵/进度——老账号也能补看引导；=0（skip）则标记全部完成
    const g = require('./guide');
    if (parseInt(parts[1])) {
      g.resetGuide();
      log(`[GM] 引导进度已重置（未完成 ${g.unfinishedGroups().length} 组），重登生效`);
    } else {
      g.skipGuide();
      log('[GM] 引导已标记全部完成（重登生效）');
    }
    return true;
  }
  if (cmd === 'm21_account') {
    // m21_account：打印当前账号与账号库（多账号自查，无回包）
    const cur = stateMod.currentAccountName() || '(未走账号流程)';
    log(`[GM] 当前账号=${cur} 存档=${require('path').basename(stateMod.getStateFile())} 角色名=${S.roleName}`);
    log(`[GM] 账号库：${ACC.list().map(a => `${a.name}${a.hasPass ? '(密码)' : ''}`).join(' / ') || '(空)'}`);
    return true;
  }
  if (cmd === 'm21_savefile') {
    // m21_savefile=1（一百八十二）：把存档 JSON 经 m_debugger_info_toc 回传客户端。
    // **二百零一停用**：客户端 m_debugger_info_toc → openLogDetailPanel(data) → 单个 Text 吃
    // 236KB 字符串，必爆 `String too long for TextMeshGenerator` / `Mesh can not have more
    // than 65000 vertices`（一百八十二第二败，用户实拍）。当时的结论就是"此路不通，改走 HTTP
    // 回环"，但服务端这条命令一直留着 —— 谁手打或写探针调它，客户端必崩。
    // 现在只回执指路，不再发 m_debugger_info_toc；要拿存档走 GM 面板「上传运行日志」（HTTP）。
    stateMod.flushSave();
    const file = require('path').basename(stateMod.getStateFile());
    log(`[GM] m21_savefile 已停用（236KB 回传会撑爆客户端 Text）；存档文件=${file}，请用「上传运行日志」`);
    return { ok: false, msg: `✗ 存档回传已停用（会撑爆客户端文本框）\n改点「上传运行日志」按钮\n档名：${file}` };
  }
  // ---- 面板语义适配：官方名按"誓灵类型ID"操作，本服实例模型按"实例 id"（二百零一）----
  // 面板这些条目的首参由 chooserType=2 选择器给出，是 **CfgServant 类型ID**（如 1432003），
  // 而服务端既有的 m21_set_level / m21_star / m21_feeling 收的是 **实例 id**（S.servants[].id）。
  // 直接别名会"找不到誓灵"，所以这里按类型展开到该类型的全部实例。
  if ((cmd === 'm21_servant_lv' || cmd === 'm21_servant_star' || cmd === 'm21_servant_feeling'
    || cmd === 'm21_servant_exp' || cmd === 'm21_energy' || cmd === 'm21_servant_break')
    && parts.length >= 2) {
    const typeId = parseInt(parts[1]);
    const val = parseInt(parts[2]);
    const targets = S.servants.filter(b => Number(b.type) === typeId);
    if (!Number.isSafeInteger(typeId) || !typeId) return { ok: false, msg: `✗ 誓灵类型ID非法：${parts[1]}` };
    if (!targets.length) return { ok: false, msg: `✗ 未持有该誓灵（type ${typeId}），先用「获得誓灵」` };
    const EV = require('../data/evolution_rules');
    if (cmd === 'm21_servant_lv') {
      const lv = Math.max(1, val || 1);
      const changes = [];
      targets.forEach(b => {
        b.level = Math.min(lv, TRAIN.maxLevelOf(b)); b.exp = 0;
        changes.push({ servant_id: b.id, key: CHANGE_ID_LEVEL, val: b.level }, { servant_id: b.id, key: CHANGE_ID_EXP, val: 0 });
      });
      saveState();
      pushServantChanges(conn, changes);
      return { ok: true, msg: `✓ 设置等级 Lv${targets[0].level}：${targets.length} 只（上限 Lv${TRAIN.maxLevelOf(targets[0])}）` };
    }
    if (cmd === 'm21_servant_star') {
      const st = Math.min(EV.MAX_STAR, Math.max(EV.BASE_STAR, val || EV.BASE_STAR));
      targets.forEach(b => { b.star = st; });
      saveState();
      require('./servant').handlers.m_servants_brief_tos(conn); // 列表星星即时刷新（与 m21_star 同口径）
      return { ok: true, msg: `✓ 设置星级 ${st}★：${targets.length} 只` };
    }
    if (cmd === 'm21_servant_feeling') {
      const FR = require('../data/feeling_rules');
      const fm = require('./feeling');
      const now = Math.floor(Date.now() / 1000);
      const v = Math.max(0, Math.min(100, val || 0));
      targets.forEach(b => {
        b.feeling = Math.min(v, FR.maxFeelingOf(b));
        b.satisfaction = 0;
        if (!Array.isArray(b.feeling_record)) b.feeling_record = [];
        for (const ms of require('../data/feeling_data').RECORD_MILESTONES) {
          if (b.feeling >= ms && !b.feeling_record.some(r => Number(r.id) === ms)) b.feeling_record.push({ id: ms, val: now });
        }
      });
      saveState();
      fm.pushFeelingChanges(conn, targets);
      return { ok: true, msg: `✓ 设置羁绊 ${v}：${targets.length} 只` };
    }
    if (cmd === 'm21_servant_exp') {
      const exp = Math.max(0, val || 0);
      const changes = [];
      targets.forEach(b => {
        const r = TRAIN.applyServantExp(b, exp);
        changes.push({ servant_id: b.id, key: CHANGE_ID_EXP, val: r.exp });
        if (r.level !== r.oldLevel) changes.push({ servant_id: b.id, key: CHANGE_ID_LEVEL, val: r.level });
      });
      saveState();
      pushServantChanges(conn, changes);
      return { ok: true, msg: `✓ 加经验 ${exp}：${targets.length} 只 → Lv${targets[0].level}` };
    }
    if (cmd === 'm21_energy') {
      const ED = require('../data/energy_data');
      const n = Math.min(ED.ENERGY_CEIL_MAX, Math.max(1, val || ED.ENERGY_CEIL_MAX));
      targets.forEach(b => { b.energy_ceils = ED.ENERGY_PROPS.reduce((o, p) => (o[p] = n, o), {}); });
      saveState();
      return { ok: true, msg: `✓ 能源上限 ${n}：${targets.length} 只（重进详情生效）` };
    }
    // m21_servant_break
    const BK = require('../data/break_data');
    const step = Math.max(0, Math.min(BK.MAX_OVERSTEP, val || 0));
    targets.forEach(b => { b.overstep = step; });
    saveState();
    pushServantChanges(conn, targets.map(b => ({ servant_id: b.id, key: CHANGE_ID_OVERSTEP, val: step })));
    return { ok: true, msg: `✓ 设置突破 ${step} 突：${targets.length} 只（等级上限 Lv${TRAIN.maxLevelOf(targets[0])}）` };
  }
  if (cmd === 'm21_guide' && parts.length >= 2) {
    // 面板「完成引导」=m21_guide=<到步骤>，官方按步骤跳；本服引导只有"重置/跳过"两档，
    // 因此 >=999 视为"全部完成"（面板默认值就是 999），其余明确回执不支持跳步。
    const g = require('./guide');
    const step = parseInt(parts[1]) || 0;
    if (step >= 999) {
      g.skipGuide();
      return { ok: true, msg: '✓ 引导已标记全部完成（重登生效）' };
    }
    return { ok: false, msg: `✗ 本服引导不支持跳到第 ${step} 步\n只支持 999=全部完成 或 m21_guide_reset=1` };
  }
  log('[GM] 未实现的指令:', msg);
  return 'UNIMPLEMENTED';
}

// ============================================================================
// 重连快路径：**不重推全量 brief**（2026-10-21 苏芸曦反馈·突破崩）
//
// 现状：`conn.servantsBriefSent` 是**连接级**状态，客户端切后台回前台会重连
// （SettingModule → Net2.onReconn），每条新连接都当成"新客户端"再推一次全量 brief。
// 而客户端 `initServantInfo` 重建实例列表/字典，**却不清类型计数表**；随后对每个
// 已存在实例调 `addServant`，其计数是**无条件 +1** → 每重连一次，每个 type 的计数
// 再 +N。删掉某 type 最后一只后计数仍 >0 → 任何 fame 推送在
// `ServantAltarDetailVO.updateRankList` 取空表 `.level` 崩（指南 D7⑤/⑥）。
// 实测（23_21_00 日志）：一次客户端会话 **10 次连接 = 10 次全量 brief**，严格 1:1。
//
// 判据（日志实证）：`m_auth_key_tos` 带 `is_reconnect`（本次进程内第 N 次重连，
// 首连为 0）+ `session_id`（同一次客户端会话内恒定）。两个条件同时满足、且**本进程
// 确实给这个 session 推过一次全量**，才走快路径——否则一律照旧发全量：
//   · 冷启动 → is_reconnect=0 → 全量；
//   · 服务端重启（账本清空）→ 全量；
//   · session_id 变了 → 全量。
// 快路径只把 `briefedIds` 账本补全（客户端手里本来就是完整快照），不发包。
const FULL_BRIEF_SESSIONS = new Set();      // `${账号}|${session_id}`
const FULL_BRIEF_SESSIONS_MAX = 64;
function fullBriefKey(conn) {
  return `${conn && conn.accountName}|${conn && conn.clientSession}`;
}

// 存量自愈（2026-10-25）：历史上糖果抽奖把「誓灵凭证（3e7+type，form=3）」、成就把「称号盒
// （25001001~25001999，form=2）」当普通道具发进过背包——都是材料页死道具（不可使用），
// 且誓灵/称号从未到账（用户反馈「糖果抽奖的鲁格在材料背包不在誓灵小屋」即此）。
// 登录链最前（全量 brief / 背包列表之前）把死道具兑换成真实奖励并删除条目：
// 新誓灵随登录 pushServantsBrief 自然宣告（零额外包、绕开 D7⑤⑥ 全量重推问题），称号入册后
// 由 m_role_title_list_tos / pushTitleUpdate 自然可见。幂等（扫空即无操作），多账号安全。
function scrubLegacyBagRewards() {
  const TK = require('../data/servant_token_data');
  const TD = require('../data/title_data');
  const TITLE = require('./title');
  const SV = require('./servant');
  let servants = 0, titles = 0, removed = 0, silver = 0, boxes = 0;
  const dropped = [];
  const kept = [];
  for (const g of S.bagGoods) {
    const tid = Number(g && g.type_id);
    if (TK.isServantToken(tid)) {
      // cur_num 张凭证 = cur_num 只誓灵（重复誓灵合法；grantServantBrief 入档查重防 id 撞号）
      const n = Math.max(1, Math.floor(Number(g.cur_num) || 1));
      for (let i = 0; i < n; i++) {
        const b = SV.makeServantBrief(TK.servantTypeOfToken(tid));
        if (b) { SV.grantServantBrief(b); servants++; } else dropped.push(tid);
      }
      removed++;
      continue;
    }
    if (TD.isTitleBox(tid)) {
      const r = TITLE.grantTitle(tid);
      if (r) { titles++; if (r.dup) silver += 1500; } else dropped.push(tid);
      removed++;
      continue;
    }
    // 进化素材Lv1/2/3（20000900~902，二百七十八）：官方奖励表遗留死箱（客户端 link=0 无任何
    // 消费口，见 lib.js DEAD_BOX_SUBSTITUTE 注释）。存量堆叠**原地转换**成同档百变素材模型
    // （数量/gid 不变，改 type_id+bag_type）——非"删除重发"路径，客户端随本次登录的背包
    // 全量下发直接看到转换后的道具，无需额外推送。幂等：转换后不再是键，重登零操作。
    if (L.DEAD_BOX_SUBSTITUTE[tid]) {
      g.type_id = L.DEAD_BOX_SUBSTITUTE[tid];
      g.bag_type = bagTypeOf(g.type_id);
      boxes++;
    }
    kept.push(g);
  }
  if (!removed && !boxes) return;
  S.bagGoods = kept;
  saveState();
  log(`[login] 存量自愈：背包 ${removed} 项死道具 → 誓灵 ${servants} 只 / 称号 ${titles} 个`
    + `${silver ? `（重复称号折银 ${silver}）` : ''}${dropped.length ? `；丢弃非法 ${dropped.join(',')}` : ''}`
    + `${boxes ? `；进化素材箱→百变素材模型 ${boxes} 条` : ''}`);
}

function triggerLoginPushes(conn) {
  if (!conn || conn.loginPushesStarted) return;
  conn.loginPushesStarted = true;
  // 背包死道具兑换必须先于 servantsBriefSent 判定与全量 brief（新誓灵要搭这班车宣告）
  try { scrubLegacyBagRewards(); } catch (e) { log(`[login] 存量自愈异常（忽略）：${e && e.message}`); }
  const isAlive = () => Boolean(conn && conn.sock && !conn.sock.destroyed && !conn.isClosed);
  // 看板娘、祭坛和编队都依赖完整誓灵 VO。编码层已由安卓 CLR 整包接管，
  // 此处直接建立完整快照，避免先缺数据、再由定时器补齐造成登录依赖阻塞。
  if (isAlive() && !conn.servantsBriefSent) {
    const reconnect = Number(conn.reconnectAuth) > 0 && conn.clientSession
      && FULL_BRIEF_SESSIONS.has(fullBriefKey(conn));
    if (reconnect) {
      const SV = require('./servant');
      conn.servantsBriefSent = true;
      conn.servantsBriefCompact = false;
      conn.briefedIds = conn.briefedIds || new Set();
      for (const b of SV.briefableServants(S.servants)) conn.briefedIds.add(Number(b.id));
      const ids = SV.pushPendingServants(conn);   // 断线期间新入档的实例补宣告（通常 0 只）
      log(`[servant] 重连快路径：跳过全量 brief（is_reconnect=${conn.reconnectAuth} `
        + `session=${String(conn.clientSession).slice(0, 8)}），增量补宣告 ${ids.length} 只`);
    } else {
      pushServantsBrief(conn);
      if (conn.clientSession) {
        if (FULL_BRIEF_SESSIONS.size >= FULL_BRIEF_SESSIONS_MAX) FULL_BRIEF_SESSIONS.clear();
        FULL_BRIEF_SESSIONS.add(fullBriefKey(conn));
      }
    }
  }
  // Pad 7 上 Jint 只有一个工作线程。登录后客户端会立刻连续请求背包，
  // 若把这些“顶栏/签到/活动状态”继续排在 600~1700ms 定时器里，背包的
  // 同步 ETF 编码会把它们推迟到主城进入后十几秒。先发用户能立即看到的
  // 状态，再进入其余低优先级登录同步；客户端重复请求仍由原 handler 正常应答。
  if (isAlive()) {
    try { require('./activity').pushRoleActs(conn); } catch (e) { /* 保持后续登录链 */ }
    // 凭神回响的可获回响誓灵名单：客户端**从不主动发** m_echo_servant_info_tos（反编译全库无调用方），
    // 而分解面板（SummonDecomposeSelectPanel/SummonDecomposePanel 的 lblEcho）要靠它算"预计获得"。
    // 与活动开关 1009 同一批下发，保证"回响列可见 + 数字正确"同时成立。
    try { require('./summon').pushEchoServantInfo(conn); } catch (e) { /* 保持后续登录链 */ }
    try { require('./activity').handlers.m_role_sign_info_tos(conn, { reward_list_id: 0 }); } catch (e) { /* 保持后续登录链 */ }
    try { require('./vit').onLogin(conn); } catch (e) { /* 保持后续登录链 */ }
    // 协会场景售货机气泡（id=5 供应中/缺货中）：rewardDic[5] 唯一写入通道，不推则
    // HouseFurRewardItem 永远不创建 ⇒ 售货机无气泡也无点击入口（与 vit 的 id=1/2 同批）
    try { require('./dorm').depotNotify(conn); } catch (e) { /* 保持后续登录链 */ }
    // 银匙之门入口按钮的"剩余次数：N"：客户端只在打开入口面板时才拉 info，
    // 按钮数据源 DreamMgr.dailyTimes 默认 0 —— 登录即推（dream 内部按功能 16 开启过滤，二百九十九）
    try { require('./dream').onLogin(conn); } catch (e) { /* 保持后续登录链 */ }
  }
  // 登录同步功能开启列表（GuideMgr.updateFuncOpenList）：空列表会让所有待解锁功能
  // 永远提示"通关X-X后开启"（协会=1，通关1-2解锁）
  setTimeout(() => { if (isAlive()) pushFunctionList(conn); }, 600);
  // 登录同步活动开放列表（ActivityMgr.updateAllActs）：新手引导期间客户端未通关组52前
  // 不会主动发 m_role_acts_tos，服务端主动下发保证客户端 ActivityMgr.isOpenAct/isRewardAct
  // 始终持有开启状态，防止各类系统读活动配置时因 isOpenAct=false 判空崩溃
  // 活动状态已在上面的高优先级同步发送；保留一个较晚的幂等补发窗口，
  // 兼容早期客户端在连接刚建立时丢包的情况。
  setTimeout(() => { if (isAlive()) { try { require('./activity').pushRoleActs(conn); } catch (e) { /* 忽略 */ } } }, 2500);
  // 二周年抽奖（1649）：登录第 700ms 主动下发参与奖状态，消除客户端刚进主城打开抽奖时的冷启动空窗期
  setTimeout(() => { if (isAlive()) { try { require('./act_extra').pushDailyLuckDrawInfo(conn, 1649); } catch (e) { /* 忽略 */ } } }, 700);
  // 登录同步剧情播放记录（图鉴解锁）：客户端 TheaterModule 从不主动拉取
  // （onEnterGame 为空），m_theatre_info_toc 官方为服务端主动推——不推则图鉴全部
  // 显示"需通关该章节才可进行剧情回放"
  setTimeout(() => { if (isAlive()) conn.sendToc('m_theatre_info_toc', { list: playedTheaters() }); }, 900);
  // 信件：欢迎信/72h 公益信判定 + 未读红点（m_letter_light_toc 纯推送——letterNum 驱动
  // 邮件面板空态与分页，不推则"有信也显示空"；佩戴称号的聊天/名片显示也在这里补推）
  setTimeout(() => { if (isAlive()) require('./letter').onLogin(conn); }, 1000);
  // 任务：累计登录天数（condType 20，按日去重）
  setTimeout(() => { if (isAlive()) advanceMissions(conn, { login: true }); }, 1200);
  // 活动扩展：登录事件（世界树 m1/绫音 m1/集结 m1 每日登录 + 星座·小千日记登录天数）+ 助手列表推送
  setTimeout(() => { if (isAlive()) { try { require('./act_extra').actEvent(conn, 'login', 1, null); require('./act_extra').onLoginPushes(conn); } catch (e) { /* 忽略 */ } } }, 1300);
  // 结社：周期重置（签到/宝箱次数/周贡献）+ 有结社则开结社聊天频道
  //（客户端本地没有结社频道默认项，不推 m_chat_room_update_toc 就没有这个页签）
  setTimeout(() => { if (isAlive()) require('./family').onLogin(conn); }, 1500);
  // 体力：顶栏数值/上限 + 研究所产出气泡（GlobalData.initData 不会把 role_scores[5] 同步给
  // GlobalData.vit，不推 m_vit_update_toc 顶栏体力恒 0；上限也只能靠 m_dynamic_limit_toc 推）
  // 体力已在高优先级同步发送；此处只做兜底重推。
  setTimeout(() => { if (isAlive()) require('./vit').onLogin(conn); }, 3000);
  // 阵型解锁列表（CopyMgr.initLineUp）：主动推避免布阵面板首次打开才拉取的等待，
  // 也让"新解锁阵型"红点在登录后即就绪（通关推送走 map_fight 的 pushLineupIfChanged）
  setTimeout(() => { if (isAlive()) require('./servant').pushLineupInfo(conn); }, 1900);
  // 天空方舟：燃料面板（ceil/velocity 只能靠 m_ark_fuel_detail_toc 推）+ 三货币 +
  // 探索队 vol（客户端从不主动拉队伍）+ 誓灵战力批量推（方舟编队读 VO.power）
  setTimeout(() => { if (isAlive()) require('./ark').onLogin(conn); }, 2100);
  // 祭坛：主面板 onOpen 不发请求，全靠这里推（fameDic 先建、camp_list 后到，顺序不能反）；
  // fame update 也会在培养/掉落路径 diff 推送（lib.pushServantChanges 钩子）
  //
  // 完整誓灵快照在登录入口已发送，祭坛实例引用无需再轮询等待补齐。
  setTimeout(() => { if (isAlive()) require('./altar').onLogin(conn); }, 2300);
  // 图鉴：卫星名单（m_role_handbook_filter_toc 纯推送，客户端无主动拉取）+ 旧档回填 + 待查看红点
  setTimeout(() => { if (isAlive()) require('./handbook').onLogin(conn); }, 2450);
  // 红点：把玩家点掉的入口红点推回隐藏态（二百二十二遗留配套）。客户端 m_red_point_toc →
  // MainMgr.updateRedPoint（uv0[id]=val；isRedPointShow = val==SHOW(1) ⇒ val=0 = 不显示）。
  // 不推则重登后全部复活。未注册进 RedPointConst 的 id 客户端只 printTrace 一行，零副作用。
  setTimeout(() => {
    if (!isAlive()) return;
    const hidden = Object.keys(S.redPointHidden || {}).map(Number).filter(Boolean);
    if (hidden.length) conn.sendToc('m_red_point_toc', { red_points: hidden.map(id => ({ id, val: 0 })) });
  }, 2550);
  // 主线 EX 挑战关：每日次数 20004（同通道 m_activity_daily_toc 全量；不推则"次数：x/3"恒 3/3）
  setTimeout(() => { if (isAlive()) require('./map_fight').exDailyLoginPush(conn); }, 2650);
  // 曜日副本：每日次数（m_activity_daily_toc 无 tos，纯服务端推；不推则"今日剩余次数"恒 2/2 且打完不减）
  // + 今日开放章节（客户端开面板也会主动拉一次，这里是保证登录即就绪）
  setTimeout(() => { if (isAlive()) require('./daily_copy').onLogin(conn); }, 2600);
  // 主线首通奖励红点（m_copy_story_red_point_toc 纯推送，不推则章节页签红点要重登才出现）
  // + 双倍状态（客户端 CopyMainLineView 打开时也会拉一次）
  setTimeout(() => { if (isAlive()) require('./story_reward').onLogin(conn); }, 2750);
  // 羁绊：今日心愿（客户端只在 onEnterGame 拉一次、没有刷新协议 → 日切后靠这里重推）
  setTimeout(() => { if (isAlive()) require('./feeling').onLogin(conn); }, 2900);
  // 御灵士：化身装扮（已创建时推 m_role_costume_toc——客户端 m_role_costume_tos 定义了但
  // 无人调用，化身数据只能靠服务端推；未创建不推，客户端走创建面板）+ 星图快照
  setTimeout(() => { if (isAlive()) require('./grow').onLogin(conn); }, 3050);
  // 言灵录：数量/未读（m_moments_num_toc **无 tos、纯推送**——客户端的 allTrendsNum 与入口红点
  // 都靠它），同时做一次触发条件判定（存量档按已有协会入住/派遣/等级等一次性补解锁）
  setTimeout(() => { if (isAlive()) require('./moment').onLogin(conn); }, 3200);
}

// ---- 主城快捷面板（MainAppPanel，主城左侧"平板桌面"式应用页）布局 ----
// ⚠️ 这条协议不实现 = "切屏出去一段时间回来面板空白"（二百七十五）。完整因果链：
//   1) 切屏 → 断线重连是**新连接**；服务端 m_auth_key_toc 恒回 is_reconnect:0
//      ⇒ 客户端把重连当冷启动，重走 m_role_detail_toc → 重发 ENTER_GAME；
//   2) MainModule.onEnterGame 重发 m_main_app_info_tos + 本地 MainMgr.initByConfig()；
//   3) 本协议此前无 handler，fallback 回 {pages:[]} ⇒ 客户端 initAppInfo 走
//      `#pages==0 → initByConfig()` 兜底，而 initByConfig **每次把 page1 整个换成新空 VO**，
//      checkAppsOpen 又只在 MainMgr 的 app 缓存**未命中**时才往页里加图标（真机 bc 符号化实证，
//      `u0_10[typeID]==nil and getApp(...)` 才 addApp）——首登后缓存已热 ⇒ 重连后 page1 永久空
//      = 面板只剩背景（"凌晨 0:35" 头部还在，内容区无图标）。
// 修法 = 实现协议本体：回真实 pages。initAppInfo 对服务端页走 updateAppPositions 的
// getApp(id,true) **强制通道**（不查缓存、不看 isAppFuncOpen），与缓存冷热无关，重连必重建。
// 客户端自拖图标后发 m_main_app_save_tos（拖动 0.4s 后自动保存）→ 落盘 S.mainAppLayout，
// 此后 info 回"已存布局 ∪ 新解锁 app"——与官方"布局持久化"语义一致。
const MAIN_APP_MAX_X = 7, MAIN_APP_MAX_Y = 5; // 客户端 MainConst.MAX_TILE_X/Y
function buildMainAppPages() {
  const saved = Array.isArray(S.mainAppLayout) ? S.mainAppLayout : [];
  const savedIds = new Set(saved.flatMap(p => (Array.isArray(p.positions) ? p.positions : []).map(x => Number(x.id))));
  const funcs = buildOpenFunctions();
  const pd = {
    funcDormOpen: funcs.includes(1), // GuideConst.FUNC_ID_DORM=1（通关 1-2，lib.js FUNC_UNLOCK）
    dispatchUnlocked: () => require('./dorm').autoDispatchUnlocked(), // 通关主线 3-4（CfgDorm.tabUnlockLogic）
    shelfUnlocked: id => require('./dorm').shelfUnlocked(id),         // 补给货架（dorm.js 权威）
  };
  const defaults = MAIN_APPS
    .filter(a => !savedIds.has(a.typeID) && appPredicate(a, pd))
    .map(a => ({ id: a.typeID, val: a.pos.x + a.pos.y * 1000 }));
  const pages = saved
    .filter(p => Number(p.page) >= 1)
    .map(p => ({ page: Number(p.page), positions: (Array.isArray(p.positions) ? p.positions : []).slice() }))
    .sort((a, b) => a.page - b.page);
  if (defaults.length) {
    let p1 = pages.find(p => p.page === 1);
    if (!p1) { p1 = { page: 1, positions: [] }; pages.unshift(p1); }
    p1.positions = p1.positions.concat(defaults);
  }
  return pages;
}

module.exports = {
  handlers: {
m_bgp_login_tos(conn) {
  conn.sendToc('m_bgp_login_toc', {});
},

m_auth_key_tos(conn, obj) {
  const uid = String(obj.uid || '');
  const token = String(obj.session_id || '');
  const r = ACC.resolveLogin(uid, token);
  if (!r.ok) {
    // succ≠1 时客户端只埋点、不弹窗（LoginModule.m_auth_key_toc），所以 reason 只进日志。
    // 正常流程走不到这里：账号在 HTTP /ps_account 阶段已校验（单机服无密码，二百九十三），
    // 到这一步 token 必然有效。
    log(`[auth] 拒绝登录 uid=${uid}：${r.err}`);
    conn.sendToc('m_auth_key_toc', Object.assign(defaultFill('m_auth_key_toc'), { succ: 0, reason: r.err }));
    return;
  }
  if (r.legacy) log(`[auth] uid=${uid} 是 APK 写死的 SDK UserID（客户端账号补丁未生效）→ 回落账号 ${r.acc.name}`);
  // 顶号：S 是单例，两条连接跑不同账号会互相写坏存档 —— 后来者赢，旧连接直接断开
  if (activeConn && activeConn !== conn && activeConn.sock && !activeConn.sock.destroyed) {
    log('[auth] 已有连接在线，踢掉旧连接');
    try { activeConn.sock.destroy(); } catch (e) { /* 已断开 */ }
  }
  activeConn = conn;
  conn.accountName = r.acc.name;
  // 重连判据（见 triggerLoginPushes 上方注释）：客户端自报「本次进程内第 N 次重连」+ 客户端会话 id
  conn.reconnectAuth = Math.max(0, Number(obj.is_reconnect) || 0);
  conn.clientSession = String(obj.session_id || '');
  const sw = stateMod.useAccount(r.acc);
  log(`[auth] 登录账号 ${r.acc.name}（${sw.switched ? (sw.created ? '新建' : '切档') : '同账号'}），角色名 ${S.roleName}`);
  conn.detailSent = false;
  conn.sendToc('m_auth_key_toc', Object.assign(defaultFill('m_auth_key_toc'), {
    succ: 1,
    reason: '',
    is_new_role: 1,
    map_id: 1,
    level: 1,
    default_faction: 1,
    zone_id: 1,
    pf: 5,
    server_online_time: Math.floor(Date.now() / 1000),
    role_name: S.roleName,
    token: r.acc.token,
    is_reconnect: 0,
    time_offset: 28800,
  }));
  // auth 成功后客户端应回 m_role_detail_tos；若 3 秒未回，服务端主动推送 detail（双保险）
  setTimeout(() => {
    if (!conn.detailSent) {
      log('[role] 客户端未请求 detail，服务端主动推送');
      conn.detailSent = true;
      sendRoleDetail(conn);
      triggerLoginPushes(conn);
    }
  }, 3000);
},

m_role_detail_tos(conn) {
  if (conn.detailSent) { log('[role] detail 已发送过，跳过重复请求'); return; }
  conn.detailSent = true;
  sendRoleDetail(conn);
  triggerLoginPushes(conn);
},

m_role_create_tos(conn, obj) {
  log('[role] 创建角色:', obj.role_name, 'cate =', obj.category);
  if (obj.role_name) S.roleName = obj.role_name;
  conn.sendToc('m_role_create_toc', Object.assign(defaultFill('m_role_create_toc'), { succ: 1, reason: '' }));
  // 客户端收到 create_toc 后未必主动拉详情，服务端直接推送
  setTimeout(() => {
    if (!conn.detailSent) {
      conn.detailSent = true;
      sendRoleDetail(conn);
      triggerLoginPushes(conn);
    }
  }, 500);
},

// 客户端 ErrorMgr.checkSendBack：每个 tos 发出后若迟迟收不到任何 toc 就弹"网络较差"。
// m_ack_list_toc 必须回（客户端还有专门的 m_ack_list_toc 处理链）
m_ack_list_tos(conn) {
  conn.sendToc('m_ack_list_toc', defaultFill('m_ack_list_toc'));
},
m_bgp_client_ip_tos(conn) {
  // BGP 分支专用、客户端在此部署下不发；但"忽略"也必须回包（D2 / 二百二十二），
  // 否则一旦某条链路开始发它就变成 13 秒「服务端未响应」
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
// 调试聊天/GM 指令回显会让客户端 handler 报错，普通聊天不回 m_chat_in_channel_toc；
// m21_ GM 指令由服务端执行。但所有路径都要回包：客户端对每个 tos 启动 1 秒等待
// （checkSendBack），不回会弹 NetWaitPanel——未实现的 GM 指令（如 m21_no_guide）曾被
// 客户端重发上百次、每次都弹 loading。统一回 m_common_reply_toc（proto_id=0 静默忽略）
// 聊天：m21_ GM 指令由服务端执行（不回显，回显会让客户端 GM handler 报错）；
// 普通发言按官方回 m_chat_in_channel_toc 原样回显（结社主界面内嵌聊天、世界频道都靠它上屏）。
// role_info 声明是 array 实际按单对象(104)下发——发成数组客户端字段全 nil，
// 且 ChatModule 会拿 role_info.role_id 与 MyRoleID 比对来清输入框/滚到底部。
// 所有路径都要回包：客户端对每个 tos 启动 1 秒等待（checkSendBack），不回会弹 NetWaitPanel
// GM 面板「指令」类按钮的正式通道（DebugModule.sendRoleGMCommand → m_role_gm_command_tos）。
// 之前没有此 handler：请求落 start.js Proxy 兜底静默回包，m21_savefile 一直拿不到回包
//（一百八十二事故：聊天通道的 handleGmCommand 和这个通道是两条路）。
m_role_gm_command_tos(conn, obj) {
  const cmd = String(obj && obj.cmd || '');
  let r = null;
  if (cmd.startsWith('m21_')) r = handleGmCommand(conn, cmd);
  else log('[GM] 面板通道非 m21 指令:', cmd);
  // 回执（二百零一）：m_role_gm_command_toc → 客户端 DebugModule 弹 Alert。这是面板唯一能
  // "看见结果"的通道，此前服务端从未发过；未实现/参数错也必须有回执，否则点了像卡死。
  if (r && r.msg) conn.sendToc('m_role_gm_command_toc', { msg: String(r.msg).slice(0, 200) });
  else if (!r) conn.sendToc('m_role_gm_command_toc', { msg: `✗ 只接受 m21_ 指令：${cmd || '(空)'}` });
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
m_chat_in_channel_tos(conn, obj) {
  const msg = obj.msg || '';
  if (msg.startsWith('m21_')) {
    // 面板 82/98 条目实际走这条道（DebugModule.sendGM → ChatModule.toChat），
    // 所以回执也必须在这里发；m21_set_helper 这类客户端补丁内部调用不弹窗（r.silent）。
    const r = handleGmCommand(conn, msg);
    if (r && r.msg && !r.silent) conn.sendToc('m_role_gm_command_toc', { msg: String(r.msg).slice(0, 200) });
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  const channel = Number(obj.channel) || 0;
  const CHANNEL_WORLD = 1, CHANNEL_FAMILY = 2;
  if (!msg || ![CHANNEL_WORLD, CHANNEL_FAMILY].includes(channel)) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const family = require('./family');
  if (channel === CHANNEL_FAMILY && !family.hasFamily()) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const helper = S.servants[0] || {};
  conn.sendToc('m_chat_in_channel_toc', {
    channel, msg, msg_type: Number(obj.msg_type) || 0,
    role_info: { // p_chat_role（单对象）
      role_id: L.roleId, role_name: S.roleName, level: S.roleAsset.level || 1, titles: [],
      helper_type: helper.type || 0, helper_star: helper.star || 1, extra: [],
      medals: medalUseKvi().filter(m => m.id), // 聊天侧展示的佩戴勋章（p_kvi，空位滤掉）
      avatar: family.avatarOf(helper.type, true), // 三百零一：聊天自视行带头像框佩戴态
    },
    tstamp: Math.floor(Date.now() / 1000),
  });
  log(`[chat] 频道${channel} 发言回显：${msg}`);
},
m_background_use_now_tos(conn) {
  // 登录进主界面时客户端拉取当前主题（GuideModule.enterMainPanel → m_background_use_now_tos）。
  // 旧实现回 common_reply 是误判——客户端 m_background_use_now_toc 会 MainMgr.setUseTheme(id, effect)
  // 真正应用主题；回 id=0 会让 setUseTheme 找不到主题报错后回落默认主题 1。
  conn.sendToc('m_background_use_now_toc', { id: S.themeState.use, use_effect: S.themeState.effect });
},
// ---- 场景主题（个人信息页"场景主题"面板）----
// 官方按成就/活动逐个解锁（CfgMain.themes[].getTip）；本地服口径 = **全量默认解锁**（新号同）：
// ids 恒等全集（data/main_themes.js）、new_ids 恒空（无"新"红点）。解锁不落盘。
m_background_theme_tos(conn) {
  conn.sendToc('m_background_theme_toc', { ids: THEME_IDS, new_ids: [] });
},
m_background_theme_check_tos(conn) {
  // 客户端点中带"新"角标的主题时上报清红点；本地服 new_ids 恒空，无同名 toc，
  // 回 common_reply 解除 1 秒网络等待即可
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
m_change_background_theme_tos(conn, obj) {
  const id = Number(obj && obj.id) || 0;
  const effect = Number(obj && obj.use_effect) === 1 ? 1 : 0;
  if (!THEME_IDS.includes(id)) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  S.themeState.use = id;
  S.themeState.effect = effect;
  saveState();
  conn.sendToc('m_change_background_theme_toc', { id, use_effect: effect });
  log(`[theme] 切换场景主题 id=${id} use_effect=${effect}`);
},
// ---- 主城快捷面板（MainAppPanel）布局：实现与根因注释在 module.exports 之前（buildMainAppPages）----
m_main_app_info_tos(conn) {
  conn.sendToc('m_main_app_info_toc', { pages: buildMainAppPages() });
},
m_main_app_save_tos(conn, obj) {
  // 客户端只上报被拖动的那个页（AppTileObj.onDrop → convertToServerData），按页合并落盘；
  // 校验：id ∈ CfgMain.mainApps、val 解码后占格不出 7×5 —— 非法条目丢弃（不整包拒绝）。
  const pagesIn = Array.isArray(obj && obj.pages) ? obj.pages : [];
  if (pagesIn.length) {
    const merged = new Map(Array.isArray(S.mainAppLayout) ? S.mainAppLayout.map(p => [Number(p.page), p.positions]) : []);
    for (const pg of pagesIn) {
      const page = Number(pg && pg.page);
      if (!(page >= 1)) continue;
      const positions = [];
      for (const p of (Array.isArray(pg && pg.positions) ? pg.positions : [])) {
        const id = Number(p && p.id), val = Number(p && p.val);
        const app = MAIN_APPS.find(a => a.typeID === id);
        if (!app || !Number.isInteger(val) || val < 0) continue;
        const x = val % 1000, y = Math.floor(val / 1000);
        if (x < 1 || y < 1 || x + app.width - 1 > MAIN_APP_MAX_X || y + app.height - 1 > MAIN_APP_MAX_Y) continue;
        positions.push({ id, val });
      }
      merged.set(page, positions);
    }
    S.mainAppLayout = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([page, positions]) => ({ page, positions }));
    saveState();
    log(`[main-app] 保存布局：${S.mainAppLayout.map(p => `page${p.page}×${p.positions.length}`).join(' ')}`);
  }
  conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // 客户端无 m_main_app_save_toc 消费方
},
// ---- 勋章（个人信息页"勋章佩戴"装饰，CfgRole.medal 共 8 个）----
// 官方由成就/高难首通投放；本地服口径 = **全量默认拥有**（同场景主题，新号同）：
// list 恒等全集 val=1（data/medal_data.js），use=4 个佩戴位（0=空位）落盘 S.medalState。
// 客户端打开个人信息页经本协议拉取；点槽位+抽屉勋章走 equip/discharge。
m_check_medal_tos(conn) {
  conn.sendToc('m_check_medal_toc', {
    use: medalUseKvi(),
    list: MEDAL_IDS.map(id => ({ id, val: MEDAL_VAL })),
  });
},
m_equip_medal_tos(conn, obj) {
  const nth = Number(obj && obj.nth) || 0;
  const id = Number(obj && obj.id) || 0;
  if (nth < 1 || nth > MEDAL_SLOTS || !MEDAL_IDS.includes(id)) {
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  S.medalState.use[nth - 1] = id;
  saveState();
  conn.sendToc('m_equip_medal_toc', { nth, id, num: MEDAL_VAL });
  log(`[medal] 佩戴勋章 nth=${nth} id=${id}（${MEDAL_NAMES[id]}）`);
},
m_discharge_medal_tos(conn, obj) {
  const nth = Number(obj && obj.nth) || 0;
  if (nth < 1 || nth > MEDAL_SLOTS) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const old = S.medalState.use[nth - 1];
  S.medalState.use[nth - 1] = 0;
  saveState();
  conn.sendToc('m_discharge_medal_toc', { nth, id: 0 });
  log(`[medal] 卸下勋章 nth=${nth} id=${old}`);
},
// 誓灵：brief 全量（面板兜底拉取）/ 详情单对象（schema 标 array 但客户端按对象访问）
// 更换助手（个人信息页勾选即发，客户端 UI 限 5 只/最后一只不可取消）：
// 只收本服拥有的誓灵并按官方上限裁剪；空列表不该出现（兜底视为"保持当前组"，
// lastHelper 不清零——helperOrderIds 会回落成 [lastHelper] 单元素组）
m_role_profile_helper_tos(conn, obj) {
  const owned = (obj.help_id_list || []).map(Number).filter(id => S.servants.some(s => s.id === id));
  S.helperIdList = owned.slice(0, 5);
  if (S.helperIdList.length > 0 && !S.helperIdList.includes(S.helperState.lastHelper)) {
    S.helperState.lastHelper = S.helperIdList[0];
  }
  saveState();
  if (S.servants.length > 0) pushHelperGroup(conn);
  else conn.sendToc('m_role_profile_helper_toc', { help_list: [] });
},
m_role_profile_info_tos(conn) {
  // 顺手推组（helper_toc + info_toc）：客户端打开个人信息页时经此刷新看板娘组，
  // 也是"客户端补丁装晚于登录组下发"时的兜底重拉通道（updateHelpGroup 需真实 help_list）
  pushHelperGroup(conn);
},
// ---- 名片展示编队（个人主页第二页 RoleAssistantView，二百八十一）----
// 客户端契约：out-cards = **固定 6 槽、0=空位**（RoleMgr.setOutCardList 原样入账；
// getAddOutCardIndex 找第一个 0 槽、getOutCardNum 数 id~=0、geOutCardIndex 找不到返回 9）。
// 点击选择器：已选 → {servant:0, nth=所在槽}（移除）；未选且 <6 → {servant:id, nth=第一个空槽}。
// 拖拽已放置的到别的槽 → {servant:id, nth=目标槽}（移动：原槽清空，目标被占=交换）。
// 每次进第二页发 m_role_show_team_info_tos 自拉（onOpen），无需登录推。
// 展示纯装饰（名片立绘），无战斗效果。
m_role_show_team_info_tos(conn, obj) {
  conn.sendToc('m_role_show_team_info_toc', {
    to_role: (obj && obj.to_role) || L.roleId,
    name: S.showTeamState.name,
    servants: S.showTeamState.servants,
  });
},
m_change_show_team_tos(conn, obj) {
  const servant = Math.floor(Number(obj && obj.servant) || 0);
  const nth = Math.floor(Number(obj && obj.nth) || 0);
  const list = S.showTeamState.servants;
  if (nth < 1 || nth > 6) {
    log(`[showTeam] 展示编队被拒：nth=${nth} 越界`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  if (servant === 0) {
    // 移除：清空该槽（幂等）
    list[nth - 1] = 0;
  } else {
    if (!S.servants.some(s => Number(s.id) === servant)) {
      log(`[showTeam] 展示编队被拒：誓灵 ${servant} 不在册`);
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      return;
    }
    const from = list.indexOf(servant);
    const occupant = list[nth - 1];
    if (from === nth - 1) {
      // 原位，无操作
    } else if (from >= 0) {
      // 移动/拖拽换位：目标被别的誓灵占着 = 交换（拖拽重排的自然语义，无损）
      list[from] = occupant;
      list[nth - 1] = servant;
    } else if (occupant === 0) {
      list[nth - 1] = servant; // 客户端 getAddOutCardIndex 的正常路径
    } else {
      // 目标被占且新誓灵未在列：客户端只在有空位时发（num<6 门），此处兜改包——替换占位者
      list[nth - 1] = servant;
      log(`[showTeam] 槽位 ${nth} 被占，替换 ${occupant} → ${servant}`);
    }
  }
  saveState();
  conn.sendToc('m_change_show_team_toc', { servants: list });
  log(`[showTeam] 展示编队更新：[${list.join(',')}]（servant=${servant} nth=${nth}）`);
},
m_change_show_team_name_tos(conn, obj) {
  const name = String((obj && obj.name) || '').slice(0, 40);
  S.showTeamState.name = name;
  saveState();
  conn.sendToc('m_change_show_team_name_toc', { name });
  log(`[showTeam] 展示编队改名："${name}"`);
},
// 个人简介（名片描述行，二百八十一顺手闭环）：登录链 m_role_profile_info_toc.intro
// 此前两处写死 '' ⇒ 简介永远空、修改协议未实现（真机活服日志实锤）
m_role_profile_intro_tos(conn, obj) {
  S.profileIntro = String((obj && obj.intro) || '').slice(0, 100);
  saveState();
  conn.sendToc('m_role_profile_intro_toc', { intro: S.profileIntro });
  log(`[profile] 简介更新："${S.profileIntro}"`);
},
// ---- 生涯统计（个人主页第三页 RoleLifeView，二百八十一）----
// 客户端契约：m_life_achievement_info_toc{to_role, list:array<p_kvi{id,val}>} →
// RoleMgr.updateAchievementList 按 id 键化 → onGUI 用 slot2[1]..[11] 渲染 11 项
// （**list 恒空时 onGUI 早退 → 整页保持 prefab 占位文案"XXX/12/15"**——"12/15 件新衣服"
// 也是设计稿示例文本，不是真计数）。list 必须 **11 项全发**（缺项会让 Lua # 运算不齐）。
// 每次进第三页自拉（onOpen），统计值天然跟随实时数据。
// 口径（本地服自定，全部可随玩法增长）：
//   1 登记时刻(秒, letterState.createTime 毫秒换算; 老档 0 → 惰性落为当前时刻)
//   2 距今天数      3 无限领域最深层(towerState.historyMax)   4 累计通关副本(Σ barrierClears)
//   5 累计击败敌人(counters.kills)  6 寻找到的同伴(正式图鉴解锁数, 狂化段除外)
//   7 邂逅誓灵数(拥有誓灵 distinct type)  8 缔结契约数(pledge_time>0 的实例)
//   9 购买服装数(skinState.owned)   10 累计派遣(counters.dispatch, dorm.js:1300 钩子)
//   11 完成成就数(achvState.claimed)
m_life_achievement_info_tos(conn, obj) {
  const C = (S.achvState && S.achvState.counters) || {};
  const barrierSum = Object.values(C.barrierClears || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const nowSec = Math.floor(Date.now() / 1000);
  let createTime = Math.floor(Number(S.letterState && S.letterState.createTime) || 0);
  if (!createTime) {
    createTime = nowSec;
    if (S.letterState) S.letterState.createTime = createTime * 1000; // letterState 用毫秒
    saveState();
  }
  const days = Math.max(0, Math.floor((nowSec - createTime) / 86400));
  const types = new Set(S.servants.map(b => Number(b.type)).filter(Boolean));
  const pledged = S.servants.filter(b => Number(b.pledge_time) > 0).length;
  const hb = (S.handbookState && S.handbookState.actives) || {};
  let handbookN = 0;
  for (const k of Object.keys(hb)) if (Number(k) < 100000000) handbookN++; // 狂化=100000000+ 段不计
  const list = [
    { id: 1, val: createTime },
    { id: 2, val: days },
    { id: 3, val: Math.max(0, Math.floor(Number(S.towerState && S.towerState.historyMax) || 0)) },
    { id: 4, val: barrierSum },
    { id: 5, val: Math.max(0, Math.floor(Number(C.kills) || 0)) },
    { id: 6, val: handbookN },
    { id: 7, val: types.size },
    { id: 8, val: pledged },
    { id: 9, val: (S.skinState && Array.isArray(S.skinState.owned) ? S.skinState.owned.length : 0) },
    { id: 10, val: Math.max(0, Math.floor(Number(C.dispatch) || 0)) },
    { id: 11, val: (S.achvState && Array.isArray(S.achvState.claimed) ? S.achvState.claimed.length : 0) },
  ];
  conn.sendToc('m_life_achievement_info_toc', { to_role: (obj && obj.to_role) || L.roleId, list });
  log(`[life] 生涯统计：登记${days}天 塔${list[2].val} 副本${barrierSum} 击杀${list[4].val} 图鉴${handbookN} 邂逅${types.size} 契约${pledged} 时装${list[8].val} 派遣${list[9].val} 成就${list[10].val}`);
},
m_role_buff_info_tos(conn) {
  let buffs = [];
  try {
    buffs = require('./collab').engineBuffs();
  } catch (e) {
    log('!! engineBuffs 异常: ' + e.message);
  }
  conn.sendToc('m_role_buff_info_toc', { buffs });
  log(`[role] 下发 role_buff_info: ${buffs.length} 个 buff`);
},
// 红点隐藏（二百二十二遗留，2026-11-07）：客户端各面板"点掉入口红点"时上报（各 Activity/Copy 面板
// → MainModule.m_red_point_hide_tos(id)）。本协议**无同名 toc**（客户端 fire-and-forget），回包由
// ensureReplied 结构性兜底 common_reply，无需显式回。客户端本地不持久化（RedPointManager/MainMgr
// 无 extcfg 落盘）⇒ 服务端不记账则每次重登红点全部复活，玩家要逐个再点一遍。
// 记账后在登录链推回（见 triggerLoginPushes 的 m_red_point_toc，val=0=不显示，MainMgr.updateRedPoint 消费）。
m_red_point_hide_tos(conn, obj) {
  const id = Number(obj && obj.id) || 0;
  if (!id) return; // 无 id：不记账，交给 ensureReplied 兜底回包
  S.redPointHidden = S.redPointHidden || {};
  if (!S.redPointHidden[id]) {
    S.redPointHidden[id] = 1;
    saveState({ defer: true }); // 同一会话可能连发多条（10-23 实测 16 次/会话），合并落盘
    log(`[role] 红点隐藏登记 id=${id}`);
  }
},
// ---- 客户端信息位（ActivityModule.m_client_info_get/set_tos）----
// id=1053：主线副本页"活动好感位引导已开"（CopyMainLineView：isOpenFavorable=false 时 set(1053,1)）。
// 此前无 handler → defaultFill {id:0} → 客户端 no-op、引导态永不记忆，每次开主线页重发一次 set。
// 2026-10-17 兜底防线收紧后（含 id 字段的 toc 拒绝 defaultFill）必须真实现，否则 1053 开关彻底失效。
// get：回显请求 id + 存储的 val（客户端只认 id==1053，其他 id no-op 安全）
m_client_info_get_tos(conn, obj) {
  const id = Number((obj && obj.id) || 0);
  const val = Number((S.clientInfo && S.clientInfo[id]) || 0);
  conn.sendToc('m_client_info_get_toc', { id, val });
},
// set：落账 S.clientInfo（新状态字段，state.js freshState/loadState 已带默认 {}）
m_client_info_set_tos(conn, obj) {
  const id = Number((obj && obj.id) || 0);
  const val = Number((obj && obj.val) || 0);
  if (!Number.isSafeInteger(id) || id <= 0) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  if (!S.clientInfo) S.clientInfo = {};
  if (S.clientInfo[id] !== val) {
    S.clientInfo[id] = val;
    saveState();
    log(`[role] client_info set id=${id} val=${val}`);
  }
  conn.sendToc('m_client_info_set_toc', { id, val });
},
// 新手引导进度上报（客户端 GuideModule.m_role_guide_do_tos）已迁至 handlers/guide.js
//（2026-09-04 三十九 实装全链路引导：进度跟踪/自设名/选灵/引导二战）。
// 旧实现回空未完成列表 = "全部完成"口径；guide.js 装配在其后并覆盖同名 handler，
// 未完成列表语义见 data/guide_data.js 头注释（2026-08-23（十三）天空方舟引导事故：
// 引导运行中 isGuiding 会吞面板点击——功能开启引导（60~125）因此**有意**不进初始未完成列表）。
  },
  handleGmCommand,
  // 供冒烟/探针直接驱动登录推送链（重连快路径的判据在 triggerLoginPushes 里）
  triggerLoginPushes,
  // 存量自愈：背包里的誓灵凭证/称号盒死道具 → 真实奖励（冒烟直调）
  scrubLegacyBagRewards,
  FULL_BRIEF_SESSIONS,
  gmDispatch, // GM 命令入口（smoke/探针直接调；协议侧经 chat 通道翻译后进）
};

