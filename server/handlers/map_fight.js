// 关卡/地图/战斗（重构自 start.js）
const { S, saveState, batchWrites } = require('../state');
const L = require('../lib');
const { log, defaultFill, normSlots, pushAssetChange, progressOf, buildOpenFunctions, pushFunctionList, pushServantChanges, CHANGE_ID_EXP, CHANGE_ID_LEVEL, CHANGE_ID_STATUS, TRAIN, ROLE_LEVEL, applyRoleExpGain, pushRoleExpChange, pushRoleLevelup } = L; // 解构导入，域内裸调用与单文件时代一致
const { MAP_CONFIGS, rollDropTier } = require('../data/map_configs');
const { EX_MAP_CONFIGS } = require('../data/map_configs_ex'); // EX 挑战关 14 关（ex 元数据：本影位/每日3次/UP 誓灵）
const { HIDDEN_MONSTER_OBJS } = require('../data/map_hidden_objs'); // 链外官方战斗点（显式隐藏，见 mapObjList）
const { rollStageDrops } = require('../data/stage_drop_data');
const FC = require('../data/fight_core');
const CH = require('../data/chaos_data');
const EV = require('../data/evolution_rules'); // 星级规整（种族值档位按 star 取，见 fightServantOf/mkAllyUnit）
const { pushTeamReset, buildFormation, battleRosterOf, teamServantOf, pushServantsBrief, makeServantBrief, pushLineupIfChanged, usingSkillsOf } = require('./servant');
const { effectOfSlot } = require('../data/lineup_data');
const { advanceMissions, playedTheaters } = require('./activity');
const { equipBonusOf, relicBonusOf, applyEnchant } = require('../data/relic_data');
const FD = require('../data/faith_data'); // 信仰加成（面板口径 + 增伤/减伤）
const ELD = require('../data/element_data'); // 元素精灵（战斗唤醒：等级表 / 专属绑定 / 技能 order）
const FS = require('../data/fight_stats'); // 结算详情页统计（mvp_stats：伤害/承伤/治疗 + MVP 推选）
const altarMod = require('./altar'); // 祭坛 buff（我方五维百分比 + 伤害/减伤）
const handbookMod = require('./handbook'); // 图鉴激活红点（掉落新誓灵时推送）
const SC = require('./skill_choice'); // 作战策略（我方自动选技按模式/预设介入，见 FC.allyChoose）

// ---- 主线章节表（二百三十六 自 m_copy_barrier_info_tos 提为模块级）----
// 章节解锁链（CfgCopy openTip"通关前一章开启"）：第 N 章开启 = 第 N-1 章四关全部通关。
// 同时服务章末解锁事件（closeClearedMap 推 m_map_info_toc）与屏障表回包两处消费。
const MAIN_CHAPTERS = {
  1: [1010100, 1010200, 1010300, 1010400],
  2: [1020100, 1020200, 1020300, 1020400],
  3: [1030100, 1030200, 1030300, 1030400],
  4: [1040100, 1040200, 1040300, 1040400],
  5: [1050100, 1050200, 1050300, 1050400],
  6: [1060100, 1060200, 1060300, 1060400],
  7: [1070100, 1070200, 1070300, 1070400],
  8: [1080100, 1080200, 1080300, 1080400],
  9: [1090100, 1090200, 1090300, 1090400],
  10: [1100100, 1100200, 1100300, 1100400],
  11: [1110100, 1110200, 1110300, 1110400],
};
const MAX_CH = 11;
// barrierId → 章号；非主线 40 图（材料本/collab/合成关）返回 0
function chapterOfBarrier(barrierId) {
  for (let ch = 1; ch <= MAX_CH; ch++) {
    if (MAIN_CHAPTERS[ch].includes(barrierId)) return ch;
  }
  return 0;
}
// barrierId 所在章是否恰好因本次通关而全清（调用时本关 boss 必须已入 cleared）→ 返回新解锁章号，否则 0
function chapterUnlockedTo(barrierId) {
  const ch = chapterOfBarrier(barrierId);
  if (!ch || ch >= MAX_CH) return 0;
  const allCleared = MAIN_CHAPTERS[ch].every(id => {
    const cfg = MAP_CONFIGS[id];
    return cfg && (progressOf(id).cleared || []).includes(cfg.bossPoint);
  });
  return allCleared ? ch + 1 : 0;
}

// ---- EX 挑战关（主线 3~9 章共 14 关，id=普通关关号+10，如 1060100→1061100）----
// 客户端事实（调研-主线EX挑战模式.md，真机 bc 实证）：
//   总开关 isOpenExMode()=getCurChapter(TYPE_MAIN)>=7（通关 6-4，cur_chapter 服务端已下发）；
//   单关解锁 barrierCanEnter(exId)=m_copy_barrier_info_toc.barriers 含 EX id（唯一判据，不下发=锁死）；
//   每日次数 getExCopyRemainTimes()=EX_COPY_MAX_TIMES-getDailyTimes(20004)，客户端只显示不拦，拒绝是服务端职责；
//   本影(HLBOSS)=链外隐藏 BOSS，绑定 cfg.ex.hlBossPos（CfgMap hlboss.stand 立绘位），不进 monsterChain。
// ⚠️ 官方 CopyConst.EX_COPY_MAX_TIMES=3；本服用户拍板改 10（三百一十四）——客户端 Net2.lua
//   PS-EX-COPY-TIMES 补丁同步改 CopyConst（显示 lblExTimes"次数：x/N"与 EX 模式自动回落门控
//   changeExMode(isOpenExCopy() && remain>0) 都现读该常量），**两处必须同值**，否则次数显示骗人
//   （显示 0/3 实际还能进，或页面提前退出 EX 模式）。
const EX_COPY_MAX_TIMES = 10;  // 官方 CopyConst.EX_COPY_MAX_TIMES=3，本服扩到 10（客户端补丁同步）
const EX_DAILY_ID = 20004;     // RoleMgr.getDailyTimes 的 actives id
const EX_UNLOCK_CHAPTER = 7;   // 262012"挑战模式在通关主线关卡6-4后开启"
// EX 关判别：主线 id 段内关号 11~14（CfgCopyDetail EX base/waves 全落此段，见 gen_ex_config.js N_DAO）
function isExCopyId(id) {
  return id >= 1011100 && id <= 1091400 && id % 100 === 0 && Math.floor(id / 100) % 100 >= 11;
}
// 普通关 id → EX 关 id（mainBarrierPayload 反查用）；无 EX 的普通关（ch1/2/10）返回 0
const EX_BY_NORMAL = {};
for (const [id, cfg] of Object.entries(EX_MAP_CONFIGS)) EX_BY_NORMAL[cfg.ex.normalId] = Number(id);
// 每日次数（跨天重置；语义=今日已通关 EX 关次数，与 getExCopyRemainTimes=3-减）
function exDaily() {
  if (!S.exState) S.exState = { day: '', used: 0 };
  const today = new Date().toISOString().slice(0, 10);
  if (S.exState.day !== today) { S.exState.day = today; S.exState.used = 0; }
  return S.exState;
}
function exRemainTimes() { return Math.max(0, EX_COPY_MAX_TIMES - exDaily().used); }
// p_daily_entry 增量（客户端 RoleMgr.dailyDic → lblExTimes "次数：x/10"，常量随 PS-EX-COPY-TIMES 补丁）
function pushExDailyUpdate(conn) {
  conn.sendToc('m_role_daily_update_toc', { updates: [{ id: EX_DAILY_ID, current_times: exDaily().used }] });
}
// 登录全量（与 daily_copy.pushDailyTimes 同通道 m_activity_daily_toc；20004 不推则剩余次数恒满）
function exDailyLoginEntry() {
  return { id: EX_DAILY_ID, current_times: exDaily().used };
}

// 主线/copy=2 的屏障表回包构建（二百三十六：m_copy_barrier_info_tos 与 closeClearedMap 的
// 章末解锁推送复用同一形状，保证 cur/max_chapter、barriers、first_reward 口径一致）。
function mainBarrierPayload(copy, chapter) {
  const ids = copy === 2
    ? [2010101, 2010201, 2010301]              // 修炼副本（材料页签第一章）
    : (MAIN_CHAPTERS[chapter] || MAIN_CHAPTERS[1]);
  // 关卡通关判定：进度里 cleared 含该关 BOSS 战斗点
  const isCleared = id => {
    const cfg = MAP_CONFIGS[id];
    return cfg ? (progressOf(id).cleared || []).includes(cfg.bossPoint) : false;
  };
  // 章节解锁链见模块级 MAIN_CHAPTERS 注释；cur/max_chapter = 玩家已解锁到的最新章节（1~10）
  let maxUnlocked = 1;
  for (let ch = 2; ch <= MAX_CH; ch++) {
    if (MAIN_CHAPTERS[ch - 1].every(isCleared)) maxUnlocked = ch; else break;
  }
  return {
    copy,
    // cur_chapter 必须恒回玩家进度章（与请求 chapter 无关）：客户端切章后内部会用 chapter=1 重拉，
    // 若回显请求值会把 CopyMgr.curChapter 覆盖成 1 → 第二章判定未解锁弹"通关第一章开启"并闪回（回归教训）
    cur_chapter: maxUnlocked,
    chapter,
    barriers: ids.map(id => ({
      barrier_id: id,
      // 通关给三星（客户端 getBarrierMaxStar 读 stars 数组长度，CopyBarrierItem 渲染星星）
      stars: (copy === 1 && isCleared(id)) ? [1, 2, 3] : [],
      servant_types: (copy === 1 && MAP_CONFIGS[id]) ? (progressOf(id).dropped || []) : [],
      drop_rate_up: [],
      servant_rate_up: [],
      pass_times: (copy === 1 && isCleared(id)) ? 1 : 0,
      // 首通奖励状态：0=未领取（客户端才显示关卡图标右下角那个奖励小图标）1=已领取。
      // 图标的红点还要求 pass_times>0，所以"通关了但没领"才亮红点（见 handlers/story_reward.js）
      first_reward: copy === 1 ? require('./story_reward').firstRewardState(id) : 0,
    }))
      // EX 挑战关条目（EX 模式下 CopyBarrierItem 原地读 copyVO.ex 的 barrierCanEnter/getBarrierMaxStar）：
      // 门控=对应普通关 bossPoint 已 cleared（客户端提示"通关此关卡普通模式后开放"，不下发=锁死）。
      // EX 无首通（CfgCopy EX 条目无 firstReward 字段，客户端 EX 模式也不画首通图标）→ first_reward 恒 0。
      .concat(copy === 1 ? ids.map(id => {
        const exId = EX_BY_NORMAL[id];
        if (!exId) return null;
        const exCfg = EX_MAP_CONFIGS[exId];
        if (!isCleared(id)) return null; // 普通关未通：连条目都不发（barrierCanEnter=false → 锁定提示）
        const exCleared = (progressOf(exId).cleared || []).includes(exCfg.bossPoint);
        return {
          barrier_id: exId,
          stars: exCleared ? [1, 2, 3] : [], // 骷髅星（EX 模式星图标换 Skull）
          servant_types: progressOf(exId).dropped || [],
          drop_rate_up: [],
          servant_rate_up: [],
          pass_times: exCleared ? 1 : 0,
          first_reward: 0,
        };
      }).filter(Boolean) : []),
    act_end_time: [],
    max_chapter: copy === 1 ? maxUnlocked : 1,
  };
}

// ---- 战斗单位 wire-id（bid）映射（一百八十八 方案 A'）----
// 引擎内部 id 一律不动（我方=真实誓灵 id）；下发到客户端的协议（p_fight_servant /
// p_update / effect / fight_list）用 unit.bid（客户端原生小 id 段，见 fight_core BID_* 注释），
// 回传的 select_list[].id 是 bid → 到 wire 前先反查回单位。
function bidAllocOf(st) {
  if (!st.bidAlloc) st.bidAlloc = FC.newBidAllocator();
  return st.bidAlloc;
}
// 我方 bid 分配：转场续战（S.fightState.allies 复用对象）已带 bid 的直接沿用，保证同一
// 战斗内 id 稳定；新单位向分配器要（跨波单调递增，绝不复用）。
function bidOfAlly(unit, st) {
  if (unit.bid && FC.isWireBid(unit.bid)) return unit.bid;
  unit.bid = bidAllocOf(st).next(0);
  return unit.bid;
}
const bidOfUnit = u => (u && u.bid != null) ? u.bid : u.id; // 敌方/兜底（无 bid 的旧路径用 id，值域断言会抓）

// 祭坛五维乘区：物攻/魔攻/物防/魔防/速度 ×(100+总加成)/100（HP 无祭坛 buff——
// 客户端 proIDToBuffIDDic 属性码 1 无映射）。原地取整，面板与实战同源
function applyAltarBuffs(attrs) {
  const { statMul } = altarMod.allyBuffs();
  attrs.phy_atk = Math.ceil(attrs.phy_atk * statMul[2]);
  attrs.mag_atk = Math.ceil(attrs.mag_atk * statMul[3]);
  attrs.phy_def = Math.ceil(attrs.phy_def * statMul[4]);
  attrs.mag_def = Math.ceil(attrs.mag_def * statMul[5]);
  attrs.speed = Math.ceil(attrs.speed * statMul[6]);
  return attrs;
}

// ---- 战斗回合引擎 ----
// 客户端是"表现+回放"模型：服务端推 m_fight_servant_fight_toc（fight_list 动作序列）驱动回合动画，
// 玩家选技能发 m_fight_skill_select_tos（自动战斗 val=0 = 服务端按 findBestSkill 镜像决策），
// 服务端按速度序结算双方行动、扣技能次数（power_point）并经 update 数组回推。
// 数值模型照客户端反编译实证（data/fight_core.js）：官方种族值公式 + 属性克制 + 真实技能表。
const FIGHT_MAX_ROUND = 30; // 兜底上限

// ---- 活动助战（CfgActivity.assistAct）· 战斗侧实现 ----
// 官方配置只有文案：客户端 CfgActivity2.dataALiveInfo.servant[].skillDes（面板那行小字），
// CfgMonster.assist 只有 {skinID,name,lv,typeID}，**没有任何效果字段** ⇒ 数值只能在这里落地。
// 文案来源：BWIKI 攻略页「精灵们的信赖」+ CfgActivity2 skillDes（两处逐字一致）。
// 作用域：copyType === 1（主线）—— CfgActivity.assistAct[1105].copyType = {1}；
//         约会大作战自己的 1104/1106/1109 副本不在表里，本来就不该吃助战。
const DAL_ASSIST_ACT = 1105;
const ASSIST_SERVANTS = {
  1: { helpId: 234600101, name: '时崎狂三', kind: 'stat', prop: 101, delta: 1, desc: '开战己方全体物攻+1' },
  2: { helpId: 234200201, name: '五河琴里', kind: 'stat', prop: 102, delta: 1, desc: '开战己方全体魔攻+1' },
  3: { helpId: 234100501, name: '四糸乃', kind: 'burst', pct: 0.5, desc: '开战随机一名敌人-50%最大生命' },
  4: { helpId: 234400401, name: '夜刀神十香', kind: 'dmg', mul: 0.25, desc: '己方所有伤害+25%' },
  5: { helpId: 234500301, name: '鸢一折纸', kind: 'vuln', mul: 0.35, desc: '敌方首次受伤+35%' },
};
// 效果事件里的「来源特性」id。助战没有官方 feature id，借用两条通用特性：
//   20000「能力变化」 —— 能力等级变化的飘字（"物攻上升了1级"），狂三/琴里用；
//   60120「伤害提升」 —— showName=0 ⇒ FeatureLoop 判 slot5=false，**静默结算不弹文案**，
//                        四糸乃的扣血用它（用 20000 会弹一句"能力变化"，语义不符）。
// 两者都在客户端 CfgFightFeature 里存在，不会 printError。
const ASSIST_FEATURE_ATTR = 20000;
const ASSIST_FEATURE_SILENT = 60120;

// copyType = copyId 右起第 7~10 位。客户端 CopyUtil.getCopyType = Util.indexNum(id,7,10)，
// 而 Util.indexNum = floor(v/10^(a-1)) % 10^(b-a+1) —— 从低位起数，与服务端这一行同式。
function copyTypeOf(copyId) {
  const n = Number(copyId) || 0;
  return Math.floor(n / 1e6) % 1e4;
}

// 当前生效的活动助战；未选精灵 / 开关关 / 非主线 / 配置缺失一律 null
function activeAssist(copyId) {
  if (copyTypeOf(copyId) !== 1) return null;
  const da = S.actExtraState && S.actExtraState.dalive;
  // 布阵面板助战开关（CopyPlanPanel.togHelp → m_act_favor_helper_tos(1105,0/1)）：
  // helperSwitch=0 关闭；字段缺失（老档）视为开，与客户端 setSwitch(showTog 缺省 1) 同口径
  if (da && Number(da.helperSwitch) === 0) return null;
  const sel = Number(da && da.select) || 0;
  if (sel <= 0) return null;
  const cfg = ASSIST_SERVANTS[sel];
  if (!cfg) return null;
  return Object.assign({ id: sel, actId: DAL_ASSIST_ACT }, cfg);
}

// 第一波开战效果。effects 直接进本回合包的 effect_list（客户端先 enter_list 再播 effect）。
// 返回人读的日志片段。
function applyAssistStart(as, allies, enemies, effects) {
  const out = [];
  if (as.kind === 'stat') {
    // 狂三/琴里：己方全体能力等级 +1（gainStat 自带 ±6 钳制与"变化为 0 不发事件"）
    allies.forEach(a => {
      const real = FC.gainStat(a, as.prop, as.delta, {
        effects, srcId: ASSIST_FEATURE_ATTR, atkId: a.id, srcServantId: a.id, phase: 1,
      });
      if (real) out.push(`${a.id}:${as.prop}${real > 0 ? '+' : ''}${real}`);
    });
    if (!out.length) out.push('全员已在上限，无变化');
  } else if (as.kind === 'dmg') {
    // 十香：全队伤害乘区 +25%（与阵型/祭坛/圣器同层，纯服务端数值，客户端无可视项）
    allies.forEach(a => { a.dmgMul = (a.dmgMul || 0) + as.mul; });
    out.push(`全员伤害 +${Math.round(as.mul * 100)}%`);
  } else if (as.kind === 'vuln') {
    // 折纸：易伤标记在下面的 applyAssistVuln 统一挂（第一波也走同一函数）
    out.push(`敌方首次受伤 +${Math.round(as.mul * 100)}%`);
  } else if (as.kind === 'burst') {
    // 四糸乃：随机一名敌人立刻损失 50% 最大生命。
    // ⚠️ 不能靠 enter_list 的 hpOverride 做「进场半血」——fightServantOf 把 hp 同时写成 max_hp，
    //    客户端会把半血当满血（血条 100%）。必须满血进场 + effect 扣血。
    // 50% 上限不会致死（hp 钳 1 只是防御性），因此不需要走死亡/掉落路径。
    const alive = (enemies || []).filter(e => e && e.hp > 0);
    if (alive.length) {
      const t = alive[Math.floor(Math.random() * alive.length)];
      const loss = Math.max(1, Math.floor(t.maxHp * as.pct));
      t.hp = Math.max(1, t.hp - loss);
      effects.push({
        trigger_count: 0,
        atk_servant_id: (allies[0] || t).id, // 客户端按 atk 查桶，不能是 0
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: ASSIST_FEATURE_SILENT,
        id: ASSIST_FEATURE_SILENT,
        effect_phase: 1,
        change_type: 200000, // HP 变化
        change_value: [-loss],
        remove_round: 0,
      });
      out.push(`爆发 ${t.id} -${loss}HP（${Math.round((t.hp / t.maxHp) * 100)}% 剩余）`);
    }
  }
  return out;
}

// 折纸：给（本波）每名敌人挂"首次受伤 +N%"标记。
// 口径：每名敌人各自首次（多波/多敌可感知）。若要与 skillDes 的"敌方受到的首次伤害"
// 严格对齐成"全场仅第一次命中"，把这里改成只挂给单个敌人、并在 fight_core 里加全局标记即可。
function applyAssistVuln(as, enemies) {
  (enemies || []).forEach(e => { if (e && e.hp > 0) e.assistFirstHitVuln = as.mul; });
}


// nature 从 type id 第 4 位数字推导（客户端 ServantConfigVO.nature = Util.indexNum(typeId,4,4) 同规则）：
// 1331003→1水 1432003→2火 1033004→3风 2011001→1水 1514010→4土 …
const natureOfType = FC.natureOf;



function mapCfg() {
  return MAP_CONFIGS[(S.mapState && S.mapState.barrierId)] || MAP_CONFIGS[1010100];
}

// 当前战斗点：优先按接敌节点（S.mapState.fighting=节点格编码），否则由地图 id 推
function currentFightPoint() {
  const cfg = mapCfg();
  // 本影（EX 链外隐藏 BOSS）：接敌节点=cfg.ex.hlBossPos → shadowPoint（CfgCopyDetail HLBOSS 波次 id）
  if (S.mapState && cfg.ex && S.mapState.fighting === cfg.ex.hlBossPos) return cfg.shadowPoint;
  // 主线 11 章"？？？"影 BOSS：接敌节点=cfg.shadow.pos → cfg.shadow.point（CfgCopyDetail ??? 波次 id）
  if (S.mapState && cfg.shadow && S.mapState.fighting === cfg.shadow.pos) return cfg.shadow.point;
  if (S.mapState && cfg.monsterFight[S.mapState.fighting]) return cfg.monsterFight[S.mapState.fighting];
  // 历史遗留：这里曾调用未定义的 fightPointOf(barrierId)（重构丢失，被唤灵殿堂回落路径首次踩中）
  // → 无接敌节点时回退到当前关卡的 bossPoint
  if (S.mapState && S.mapState.barrierId) return cfg.bossPoint;
  return cfg.bossPoint;
}

// 战斗波次：默认取配置 waves[战斗点]（波次数组，每波为敌方列表）；
// 周回连战 N 时由 m_copy_fight_tos 在 fightState.batches 覆盖为 N 个相同波
function fightBatches(st) {
  if (st && st.batches && st.batches.length) return st.batches;
  return mapCfg().waves[(st && st.copyId)] || [];
}

// 直接进布阵：客户端 m_copy_fight_prepare_toc → CopyModule.preloadOpenPlanPanel → 布阵面板 → m_copy_fight_tos。
// 主线是"接敌即布阵"推它；少女终末（无小地图）在出击/开始探索后也推它
function pushFightPrepare(conn, copyId, lastId) {
  const id = lastId || (S.mapState && S.mapState.lastId) || 1;
  conn.sendToc('m_copy_fight_prepare_toc', {
    copy_id: copyId,
    team: [buildFormation(id, S.formations[id])],
    last_id: id,
  });
}

// p_servant（战斗单位；attr schema 标 array 但客户端 Servant.UpdateData 按对象访问 .hp/.rage/.max_hp...）
// 六维照官方公式（ServantUtil.realcalcPropVal）：种族值(phyle)×等级 + 能源点 + 核心装备附加
// hp = ceil(种×lv*0.1)+50+lv*5+ceil(max(点*lv*0.2,点))；其余 = ceil(种×lv*0.05)+12+ceil(max(点*lv*0.1,点))
function fightServantOf(id, type, nature, briefPos, opt) {
  const o = opt || {};
  const lv = o.level || 1;
  // ⚠️ 下发 id = o.bid（客户端战斗 id，客户端哨兵 TAR_LEFT_SCENE 只认小 id 段——9 位 id 会被
  // FeatureLoop 当场景伪 id 替换成攻击者，飘字/特效错位，一百八十八）。o.bid 缺省回落 id 仅
  // 兜底（GM/旧路径），值域由 test_battle_id_range.js 断言守护。
  // 我方：核心附加 + 阵型回避/命中（数值与面板口径一致）；敌方：纯公式
  const cb = o.coreBonus || {};
  const le = o.lineupEff || {};
  // step（种族值档位）：我方誓灵按 ServantUtil.getStep(brief.star) 取——这是客户端面板
  // getPropPhyle 的默认口径，进化升星才会真涨属性；敌方怪物无 star → 省略，退化为按 typeId 颜色推
  const attrs = o.attrsOverride || FC.calcAttrs(type, lv, o.energyPoints || null, o.overstep || 0, cb, o.star ? FC.stepOfStar(o.star) : undefined);
  if (o.ally && !o.attrsOverride) applyAltarBuffs(attrs); // 祭坛五维乘区（仅我方；enter_list 与引擎单位同源）
  const hp = o.hpOverride || attrs.hp;
  // 技能池：我方 = 装备中的 3 槽（m_servant_skill_op 配置的 using_skill）+ 魔法箭保底
  //（三百零二：池内除箭外无攻击技时自动补已学最强攻击技，learnedIds 由调用方传 b.learned_skills；
  //  与 mkAllyUnit 的引擎池同口径——客户端战斗技能栏按本池渲染）；
  // 敌方（usingIds=null）= 技能书按等级全学
  const poolIds = o.usingIds != null
    ? FC.buildUsingPool(type, o.usingIds, o.learnedIds)
    : FC.buildSkillPool(type, lv, null);
  const ppState = o.skillsState || {}; // 转场续战：{skillId: 剩余pp}
  const skills = poolIds.map(sid => {
    const cfg = FC.skillCfg(sid) || {};
    const max = cfg.pp || 30;
    return { id: sid, type: cfg.type || 0, nature: cfg.nature || 0, power_point: ppState[sid] != null ? ppState[sid] : max, max_power_point: max, state: 0, state_reason: [] };
  });
  const statLevels = o.statLevels || {};
  const buffs = o.buffs || {};
  // skin_id：客户端战斗立绘/spine 形态的唯一来源（Servant.SetSkin / ServantInUI.setSkin：
  // 9 位皮肤 id 尾数 1-4 = spine 骨架内的星级形态 skin，floor(/100)=S_<typeId> 资源）。
  // 我方必须下发真实 skin_id（brief 口径，进化皮尾数 2/3/4 = 3/4/5 星形态）——写死 type*100+1
  // 会把满星誓灵打回初始形态（真机事故：月读 5 星战斗中头上无火）。敌方无 brief，
  // type*100+1（尾数 1）即怪物默认形态，与官方一致。
  const skin = o.skin || type * 100 + 1;
  return {
    id: o.bid != null ? o.bid : id, type, name: '', skin_id: skin, nature,
    feature: o.talent ? [o.talent] : [], item: o.relicId ? [o.relicId] : [], level: lv,
    skill: skills,
    // 战斗内 using_skill 客户端只用于预加载技能动画（FightModule addAssetUrl 遍历它取 fightAct）——
    // 发全池，避免战斗栏可用的技能动画没预载
    using_skill: poolIds,
    attr: {
      // ⚠️ shield 不能写死 0：圣器「送给妹妹的面包」等开场护盾必须随进场包下发，
      // 否则客户端血条没有护盾条（服务端有盾、表现层看不到 = 玩家认为"不生效"）。
      hp, rage: 0, shield: Math.max(0, Math.round(o.shield || 0)), element_shield: [], hp_list: [],
      max_hp_num: 1, max_hp: hp,
      phy_atk: attrs.phy_atk, mag_atk: attrs.mag_atk,
      phy_def: attrs.phy_def, mag_def: attrs.mag_def, speed: attrs.speed,
      phy_atk_lv: statLevels[101] || 0,
      mag_atk_lv: statLevels[102] || 0,
      phy_def_lv: statLevels[103] || 0,
      mag_def_lv: statLevels[104] || 0,
      speed_lv: statLevels[105] || 0,
      crit_hit_lv: statLevels[111] || 0,
      hit_rate_lv: Math.round((le.hit || 0) * 100) + (statLevels[113] || 0),
      dodge_rate_lv: Math.round((le.dodge || 0) * 100) + (statLevels[115] || 0),
    },
    brief_pos: briefPos,
    // buffs 编码口径（三百一十三）：客户端 updateAllBuff 按 `id % 1e6` 解 buffId、`floor(id/1e6)` 解
    // level（isZeroHide 类 level=0 会被拒显）、`val` 当 endRound——必须 encodeBuffVal(buffId, level)。
    // 当前所有进场路径该数组实际恒空（入场天赋在进场包发出后才跑），此修正是延迟一致性收口。
    buffs: Object.keys(buffs).map(bid => ({
      id: FC.encodeBuffVal(Number(bid), buffs[bid].level || 1),
      val: buffs[bid].duration || 0,
    })),
    morph_id: 0, power: 0,
    // 元素精灵：装备了才发单对象；未装备发空数组（etf 编成 NIL → 客户端 nil → 跳过）
    element: o.element ? elementWireOf(o.element) : [],
    role_id: 0,
  };
}

// 场上 6 格（CopyPlanView.initFiedPosList）：1=(-2,-1) 2=(-2,0) 3=(-2,1) 4=(-3,-1) 5=(-3,0) 6=(-3,1)
// brief_pos 编码 (x+500)*1000+(y+500)；我方 x<0、敌方 x>0（firstEnter/isEnemyPos 按 500000 分界）
const TILE_OF_POS = { 1: [-2, -1], 2: [-2, 0], 3: [-2, 1], 4: [-3, -1], 5: [-3, 0], 6: [-3, 1] };
function briefPosOf(tile) {
  const [x, y] = Array.isArray(tile) ? tile : TILE_OF_POS[tile];
  return (x + 500) * 1000 + (y + 500);
}

// 我方誓灵进场属性附加合计 = 核心装备 + 信仰（两者同形状，逐项相加）。
// enter_list 与引擎单位共用，保证"下发给客户端的进场数值"与"服务端结算数值"完全一致。
function allyEquipBonusOf(b, teamId) {
  const cb = equipBonusOf(b, S.bagGoods);           // 核心（面板口径）
  const fb = FD.faithAttrBonusOf(b, S.bagGoods, teamId); // 信仰（FaithVO.getProp 口径）
  for (const k of Object.keys(fb)) cb[k] = (cb[k] || 0) + fb[k];
  return cb;
}

// 服务端战斗单位：进场时从 p_servant 同源构建（attrs 与下发客户端的完全一致）
// teamId：该誓灵所在编队索引（信仰按编队独立套装 → 取该队的 faithTeams[teamId]；
//         主线战斗从 S.mapState.lastId 取，与 pushMapEnter/buildFormation 同源）
function mkAllyUnit(b, tile, eff, teamId) {  const lv = Number(b.level) || 1;
  const cb = allyEquipBonusOf(b, teamId); // 核心 + 信仰附加（面板口径）
  // 种族值档位按星级（ServantUtil.getStep）：进化升星 = 换档 = 真涨属性，与客户端详情面板同源
  const attrs = CH.normalAttrsOf(b, cb);
  const enchantBase = Object.assign({}, attrs);
  applyAltarBuffs(attrs); // 祭坛五维百分比（客户端 ServantUtil.realcalcPropVal 同口径）
  applyEnchant(attrs, S.bagGoods.find(g => Number(g.id) === Number(b.relic_gid)), enchantBase);
  const rb = relicBonusOf(b, S.bagGoods); // 圣器词条（暴击等级、暴伤倍率、暴伤减免、免暴、属性增伤等）
  const relicGoods = S.bagGoods.find(g => Number(g.id) === Number(b.relic_gid));
  if (rb.phyAtkMul) attrs.phy_atk = Math.round(attrs.phy_atk * (1 + rb.phyAtkMul));
  if (rb.magAtkMul) attrs.mag_atk = Math.round(attrs.mag_atk * (1 + rb.magAtkMul));
  // 防御百分比圣器（守护者之衣族「R 及以下」/ 突击盾族）。rOnly 按誓灵稀有度颜色（typeId 第 5 位）判定：N=1 R=2。
  if (rb.speedMul) attrs.speed = Math.round(attrs.speed * (1 + rb.speedMul));
  const rarityColor = Math.floor(Number(b.type) / 10000) % 10;
  const defOk = !rb.rOnly || rarityColor <= 2;
  if (defOk && rb.defPct) attrs.phy_def = Math.round(attrs.phy_def * (1 + rb.defPct));
  if (defOk && rb.mdefPct) attrs.mag_def = Math.round(attrs.mag_def * (1 + rb.mdefPct));
  const maxHp = attrs.hp;
  const poolIds = FC.buildUsingPool(b.type, usingSkillsOf(b), b.learned_skills); // 装备技 + 魔法箭（三百零二：空攻池补已学最强攻击技；与 fightServantOf 下发的池同口径）
  const skills = poolIds.map(sid => ({ id: sid, pp: (FC.skillCfg(sid) || {}).pp || 30 }));
  const ab = altarMod.allyBuffs();
  const fm = FD.faithFightModsOf(b, S.bagGoods, teamId); // 增伤/减伤（26 增伤 → 伤害倍率、27 减伤 → 受击减免）
  const talent = CH.talentOf(b);
  const unit = {
    id: b.id, type: b.type, nature: FC.natureOf(b.type), level: lv, side: 0, pos: tile.slice(),
    hp: maxHp, maxHp, shield: 0, attrs, skills,
    // 作战策略「自行」技能循环（FC.allyChoose modeId=6 消费；source = 存档 b.ai_skills，detail 协议同源）
    aiSkills: Array.isArray(b.ai_skills) ? b.ai_skills.slice() : [],
    // 羁绊：settleSkill 据此加暴击率/命中率（feelCritBonus/feelHitBonus，客户端面板文案的服务端实现）
    feeling: Math.max(0, Number(b.feeling) || 0),
    dmgMul: (eff.dmg || 0) + ab.dmg + fm.dmg + (rb.dmgMul || 0),
    selfMit: (eff.selfMit || 0) + ab.mit + fm.mit,
    teamMit: eff.teamMit || 0,
    dodge: eff.dodge || 0,
    critLv: rb.critLv || 0,
    critMul: rb.critMul || 0,
    critMit: rb.critMit || 0,
    immuneCrit: !!rb.immuneCrit,
    natMul: rb.natMul || {},
    weekMul: rb.weekMul || 0,
    // 「受到克制伤害后属性提升」族（复仇之刃/佛拉格拉克/轰击之枪/布里欧纳克/勇者战车/太阳神战车）：
    // settleSkill 在命中且 rel===WEEK 时读取，结算后按 prop/delta 升等级并推官方特性飘字。
    relicHurtByWeek: rb.onHurtByWeek || null,
    // 濒死保命（气息之石/命运之石）与低血回血（生命之符/安卡之符/团子）
    relicDeathSave: rb.deathSaveChance > 0 ? { chance: rb.deathSaveChance, feature: rb.deathSaveFeature } : null,
    relicLowHpHeal: rb.lowHpHeal || null,
    // 命中/回避类圣器（幻象帽族/乌加特之眼）：百分点，settleSkill 里参与命中检定
    relicDodgeBonus: rb.dodgeBonus || 0,
    relicHitBonus: rb.hitBonus || 0,
    // 批次 4：开场护盾 / 回合末随机 / 概率减伤 / 叠层增伤 / 连击 / 击倒 / 天气石 / 畏惧 / 优先度
    relicMisc: {
      openShield: rb.openShieldPct || 0,
      takenMit: rb.takenMit || 0,
      hurtMitChance: rb.hurtMitChance || null,
      stackDmgPerHurt: rb.stackDmgPerHurt || null,
      randomDmgRange: rb.randomDmgRange || null,
      repeatSkillDmg: rb.repeatSkillDmg || null,
      fearChance: rb.fearChance || 0, fearFeature: rb.fearFeature || 0,
      priorityChance: rb.priorityChance || 0,
      weatherSummon: rb.weatherSummon || null,
      onKillRandomAtk: rb.onKillRandomAtk || 0,
      roundRandomStatOrHeal: !!rb.roundRandomStatOrHeal,
      foeTakenDmgUp: rb.foeTakenDmgUp || 0,
      allyDmgUp: rb.allyDmgUp || 0,
      breakBarrier: !!rb.breakBarrier,
      // 批次 5
      noResistDamage: !!rb.noResistDamage,
      sameNatureWeek: !!rb.sameNatureWeek,
      excl: rb.excl || null, // 联动圣器专属段打包透传（2026-10-25 家族落地）
      swapDef: rb.swapDef || null,
      danmakuDmgMul: rb.danmakuDmgMul || 0,
      assistHitBonus: rb.assistHitBonus || 0,
      physSingleSplash: rb.physSingleSplash || 0,
    },
    relicCure: rb.cureOnce || null,
    relicDeathGuard: rb.deathGuardPct || 0,
    relicStartStarfish: rb.startStarfish || 0,
    // 伤害乘区 / 吸血 / 受击减伤（批次 3，见 relic_data 注释）
    relicDmg: {
      general: rb.dmgMul || 0,
      sound: rb.soundDmgMul || 0, aoe: rb.aoeDmgMul || 0, singlePhy: rb.singlePhyMul || 0,
      lifesteal: rb.lifesteal || 0, weekTakenMit: rb.weekTakenMit || 0,
      roundSelfDamage: rb.roundSelfDamage || 0, vsPositiveStats: !!rb.vsPositiveStats,
      natureDmgMul: rb.natureDmgMul || {}, takenNatureMit: rb.takenNatureMit || {},
      hurtRandomStatUp: rb.hurtRandomStatUp || 0,
    },
    talent,
    // 战斗引擎的 relicId 表示类型 ID；存档中的 relic_gid 是背包实例 ID。
    relicId: relicGoods ? Number(relicGoods.type_id) || 0 : 0,
  };
  FC.initUnitBattleState(unit);
  // 圣器开场护盾（送给妹妹的面包：开场时给予 20% 最大生命护盾）
  if (rb.openShieldPct) unit.shield = Math.round(maxHp * rb.openShieldPct);
  // 木刻海星：出场自带 1 颗海星（伊吹风子天赋按 starfish 计数）
  if (rb.startStarfish) unit.starfish = (unit.starfish || 0) + rb.startStarfish;
  if (rb.critLv) {
    unit.statLevels[111] = (unit.statLevels[111] || 0) + rb.critLv;
    unit.crit_hit_lv = unit.statLevels[111];
  }
  // ---- 元素精灵（Element Awakening）----
  // 只有"装备了元素精灵的我方誓灵"才带 element；敌方/未装备 = undefined（协议发空）。
  // 状态机（与客户端 FightMgr 同口径，asm 实证）：
  //   state = 十位剩余回合 × 10 + 个位状态（1=可唤醒 / 2=唤醒中）；rounds>0 才算"唤醒生效中"
  //   —— 客户端的 element_wake_times 必须 ≠0 才让按钮出现（见 elementWakeTimesOf）
  const elGoods = Number(b.element_gid) > 0
    ? S.bagGoods.find(g => Number(g.id) === Number(b.element_gid)) : null;
  if (elGoods && ELD.isElementItem(elGoods.type_id)) {
    const times = Math.max(0, Number(elGoods.translate_times) || 0);
    unit.element = {
      gid: Number(elGoods.id),
      lv: ELD.normLevel(elGoods.level),
      servantType: Number(elGoods.translate_type) || 0, // 0=泛用（任意誓灵）
      effectIds: times >= 2 ? [1, 2] : (times >= 1 ? [1] : []), // 已解锁的专属技能 order
      face: Array.isArray(elGoods.face) ? elGoods.face.map(kv => ({ id: Number(kv.id), val: Number(kv.val) })) : [],
      rounds: 0,   // >0 = 唤醒生效中（伤害乘区读它）
      used: false, // 本场是否已唤醒过（一场只允许一只）
    };
  }
  return unit;
}

// 元素状态 → 协议数字（p_fight_element.state）。客户端只认这个两位数：
//   FightMgr.updateElementServantList → indexNum(state,1,1)=状态、indexNum(state,2,2)=剩余回合
function elementStateOf(el) {
  if (!el) return 0;
  if (el.rounds > 0) return el.rounds * 10 + 2;
  return el.used ? 0 : 1;
}

// p_fight_element 单对象（schema 标 array<p_fight_element>，客户端直接 .state/.element_lv 读 → C1 家族）
function elementWireOf(el) {
  if (!el) return [];
  return {
    __nestedProto: 'p_fight_element',
    element_lv: el.lv,
    servant_type: el.servantType,
    servant_effect_id: el.effectIds,
    state: elementStateOf(el),
    face: el.face,
  };
}

// element_wake_times = **本场剩余可唤醒次数**（不是"已用次数"）：
// 客户端 FightMgr.getElementState 的 asm 里 `ISNEN lastElementTime 0` 决定是否承认"可唤醒"，
// ==0 时恒返回 ELEMENT_STATE_FOUR ⇒ 按钮永不出现。一场只允许一只 → 用掉即 0。
function elementWakeTimesOf(st) {
  const allies = (st && st.allies) || [];
  if (st && st.elementUsed) return 0;
  return allies.some(a => a.hp > 0 && a.element) ? 1 : 0;
}

// 元素唤醒的状态推送（唯一通道）：p_fight_effect.change_type=200005
// 客户端 FeatureLoop.checkChange(false) → `unit.element.state = change_value[i]` →
// FightMgr.updateUseElementState → 重算 elementServantId/elementRound（按钮"剩N回合"与精灵挂载）
function elementStateEffect(unit, el) {
  return {
    trigger_count: 0,
    atk_servant_id: unit.id,
    src_servant_id: unit.id,
    tar_servant_ids: [unit.id], // D9：一条一目标（change_value 按同下标取）
    src_type: 5,                // FightConst.FIGHT_EFF_ELEMENT
    src_id: 0,
    // 必须是客户端 CfgFightFeature 里存在的特性：FeatureLoop.showFeature/dealFeatureEff 对每条
    // effect 都调 GetFeature(effect.id, true)，发 0 会 printError「不存在的特性ID：0」。
    // 60120「伤害提升」showName=0 且无 tips/act ⇒ 全程静默（D15 同款，与 ASSIST_FEATURE_SILENT 一致）；
    // 唤醒状态本身走 checkChange 按 change_type=200005 分派，不读特性 VO。
    id: 60120,
    effect_phase: 1,            // TRIGGER_TIME_BORN 档：随本回合包立即结算
    change_type: 200005,        // FIGHT_EFF_CHANGE_TYPE_SERVANT_ELEMENT
    change_value: [elementStateOf(el)],
    remove_round: 0,
  };
}

// 回合推进：3→2→1→0（客户端显示"剩N回合"）。在动作结算**之前**调用，
// 使本回合伤害吃到的仍是递减后的 rounds（>0 才生效）。
function tickElementStates(st, effects) {
  const allies = (st && st.allies) || [];
  for (const a of allies) {
    const el = a && a.element;
    if (!el || !(el.rounds > 0)) continue;
    el.rounds -= 1;
    effects.push(elementStateEffect(a, el));
    log(`[element] 唤醒推进 sid=${a.id} → ${el.rounds > 0 ? `剩${el.rounds}回合` : '结束'}（state=${elementStateOf(el)}）`);
  }
}

// 本回合申请唤醒（客户端 m_fight_skill_select_tos.element_id = 发动者的 wire id）
function activateElement(st, units, wireId, effects) {
  if (!st || st.elementUsed) {
    log(`[element] 唤醒被拒：本场已用过（element_id=${wireId}）`);
    return null;
  }
  const u = (units || []).find(x => x && x.side === 0
    && (bidOfUnit(x) === Number(wireId) || Number(x.id) === Number(wireId)));
  if (!u) { log(`[element] 唤醒被拒：找不到单位 element_id=${wireId}`); return null; }
  if (!u.element) { log(`[element] 唤醒被拒：sid=${u.id} 未装备元素精灵`); return null; }
  if (u.element.used) { log(`[element] 唤醒被拒：sid=${u.id} 已唤醒过`); return null; }
  u.element.used = true;
  u.element.rounds = 3;
  st.elementUsed = true;
  effects.push(elementStateEffect(u, u.element));
  log(`[element] 元素唤醒启动 sid=${u.id} Lv${u.element.lv}`
    + `（${u.element.servantType ? `专属 ${u.element.servantType}` : '泛用'}，3 回合）`);
  return u;
}

// 元素唤醒·辅助技：本属性辅助技能 → 己方全体回复 5%~10% HP + 下次攻击 +7.5%~15%
// 客户端文案（CfgElement.mergeSkillInfo）就是这么写的，回血直接进本回合 effect_list（负伤害=治疗）
function applyElementSupport(actor, cfg, units, effects) {
  const el = actor && actor.element;
  if (!el || !(el.rounds > 0)) return 0;
  const isSupport = Number(cfg.type) === 3 || FC.isFriendEff(cfg.effType) || Number(cfg.power) === 0;
  if (!isSupport) return 0;
  if (Number(cfg.nature) !== Number(actor.nature)) return 0;
  if (el.servantType && Number(el.servantType) !== Number(actor.type)) return 0;
  const st = ELD.strengthenOf(el.lv);
  const healPct = Number(st[2]) / 100;
  const nextPct = Number(st[3]) / 100;
  let healed = 0;
  for (const a of units || []) {
    if (!a || a.side !== actor.side || a.hp <= 0) continue;
    const heal = Math.max(1, Math.round(a.maxHp * healPct * FC.healReceivedMul(a))); // 禁疗（醉人的咖啡）×0.25
    const after = Math.min(a.maxHp, a.hp + heal);
    if (after > a.hp) {
      effects.push({
        target: a.id, hurt: -(after - a.hp), final_hp: after,
        shield_hurt: 0, final_shield: Math.max(0, a.shield || 0), extra: 0,
      });
      a.hp = after;
      healed++;
    }
    a.elementNextAtkBonus = Math.max(Number(a.elementNextAtkBonus) || 0, nextPct);
  }
  return healed;
}

// 敌方 wire-id 分配：mkEnemyUnit 本身不知道战斗会话（复用方各有各的状态容器），由
// pushFightRound 在创建后统一调 assignEnemyBid 落 bid（分配器挂 S.fightState.bidAlloc，
// 跨波/替补单调递增，同场绝不复用）。
function assignEnemyBid(unit, st) {
  unit.bid = bidAllocOf(st).next(1);
  return unit;
}

function mkEnemyUnit(e, idx, tile) {
  const lv = e.level || 1;
  const nature = e.nature || FC.natureOf(e.type); // 配置里手写的 nature 优先（关卡资料），否则按 type 推
  const attrs = FC.calcAttrs(e.type, lv, null, 0, null);
  const maxHp = e.hp || attrs.hp; // wiki 实测 HP 优先
  // 敌方视为全学（等级达标）。⚠️ 无名怪（2011001~4）的技能书是从尤格/莎布等**光系**模板复制来的，
  // 关卡配置用 e.nature 手写覆盖了它们的实际属性（火/风/水/土/暗）。若直接用技能书，
  // 会出现「标着土属性却只会放光箭」（2026-10-18 真机实证）。这里把技能池里的**魔法箭**
  // 换成与 unit.nature 对应的那一支，辅助/治疗技保留（它们没有属性依赖）。
  let poolIds = FC.buildSkillPool(e.type, lv, null);
  if (e.nature && FC.natureOf(e.type) !== e.nature) {
    const arrow = FC.MAGIC_ARROW[e.nature] || 0;
    poolIds = poolIds.filter(id => !Object.values(FC.MAGIC_ARROW).includes(Number(id)));
    if (arrow && !poolIds.includes(arrow)) poolIds.unshift(arrow);
  }
  const skills = poolIds.map(sid => ({ id: sid, pp: (FC.skillCfg(sid) || {}).pp || 30 }));
  const talent = e.talent || FC.talentOf(e.type) || 0;
  const unit = {
    id: 60000001 + idx, type: e.type, nature, level: lv, side: 1, pos: tile.slice(),
    hp: maxHp, maxHp, shield: 0, attrs, skills,
    dmgMul: 0, selfMit: 0, teamMit: 0, dodge: 0, critLv: 0,
    critMul: 0, critMit: 0, immuneCrit: false, natMul: {}, weekMul: 0,
    talent,
    relicId: 0,
  };
  FC.initUnitBattleState(unit);
  return unit;
}

// 替补上位（二百八十二·续 G）：把阵亡主力逐个换成备战位存活者（同格、同阵型加成），排队
// enter 载荷与场外移除。官方败判 = 主力+替补全灭（FormationVO.isAllDie 双查 field/bench）——
// 引擎此前只算 field，有替补的队打死主力即判负，与客户端口径相反。
// 登场走**下一次** pushFightRound 的 enter_list（死亡发生在已推的回合包里，同包 born 会在
// 回放动作前 replaceUnit 掉还没播死动画的活人）；stand_list 的 remove 延迟一包生效是客户端设计
//（initOutServants 先存 remove 列表、下包才应用）。调用点：每回合开始（select_tos）+ 波转场（start_tos）。
function substituteBench(st) {
  if (!st || !Array.isArray(st.benchIds) || !st.benchIds.length) return false;
  st.pendingEnters = st.pendingEnters || [];
  st.standRemovals = st.standRemovals || [];
  let moved = false;
  for (let i = 0; i < (st.allies || []).length; i++) {
    const dead = st.allies[i];
    if (!dead || dead.hp > 0) continue;
    const bi = st.benchIds.findIndex(id => S.servants.some(x => x.id === Number(id)));
    if (bi < 0) break;
    const bid0 = st.benchIds.splice(bi, 1)[0];
    const b = S.servants.find(x => x.id === Number(bid0));
    if (!b) continue;
    const eff = dead.slotEff || { dmg: 0, selfMit: 0, teamMit: 0, dodge: 0 };
    const sub = mkAllyUnit(b, dead.pos, eff, st.teamId || 1); // 同格重建：阵型加成按所顶替的主力格生效
    sub.fieldPos = dead.fieldPos;
    sub.slotEff = eff;
    // 登场回合标记（2026-11-01 真机工单）：enter 载荷随本回合包下发，但客户端 born 在
    // 本回合**回放结束**后才执行（FightLoop.afterRound→CheckNew→onBorn）——本回合内该单位
    // 不在客户端场景里，被任何动作指向（fight_list[].effect_list[].target / atk_id）都会让
    // CheckAct/CheckHide/CheckHurt 每帧 `GetUnit(target):Play/SetVisible` nil 崩刷屏。
    // ⇒ 登场当回合不进 targeting pool（不行动、不被指向），下一回合起参战。标记自过期
    // （只在 st.round===enteringRound 的那一回合生效，无需清理）。
    sub.enteringRound = st.round;
    st.allies[i] = sub;
    st.standRemovals.push(Number(b.id)); // 场外头像移除（真实 id，与 stand_list 同空间）
    st.pendingEnters.push(fightServantOf(sub.id, sub.type, sub.nature, briefPosOf(dead.pos), {
      usingIds: usingSkillsOf(b), learnedIds: b.learned_skills, level: sub.level,
      energyPoints: b.energy_points || null, overstep: b.overstep || 0,
      coreBonus: allyEquipBonusOf(b, st.teamId || 1), lineupEff: eff, ally: true,
      star: EV.normStar(b.star),
      skin: Number(b.skin_id) || 0,
      attrsOverride: sub.attrs,
      statLevels: sub.statLevels, buffs: sub.buffs,
      talent: sub.talent, relicId: sub.relicId,
      shield: sub.shield || 0,
      element: sub.element,
      bid: bidOfAlly(sub, st),
    }));
    moved = true;
    log(`[fight] 替补上位：sid=${b.id} 顶替 sid=${dead.id}（波${st.batch || 1} 回合${st.round}）`);
  }
  return moved;
}

// 场外待命替补（p_stand_servant：战斗界面场外头像位）：id 用真实誓灵 id（纯展示层 OutServant，
// 与战斗单位的 wire bid 无关——remove 走同一空间即可）；brief_pos 为展示用序号位（4-6 备战位）。
function buildStandList() {
  const st = S.fightState;
  if (!st || !Array.isArray(st.benchIds) || !st.benchIds.length) return [];
  return st.benchIds.map((sid, i) => {
    const b = S.servants.find(x => x.id === Number(sid));
    if (!b) return null;
    return {
      id: Number(sid), type: b.type, name: b.name || '',
      skin_id: Number(b.skin_id) || (Number(b.type) * 100 + 1),
      brief_pos: briefPosOf(4 + i),
    };
  }).filter(Boolean);
}

// 推一个战斗回合包。
// round=1（round_start=1）：带 enter_list 双方进场，同时初始化 S.fightState 血量表；
// 之后（round_start=0）：fight_list 携带动作序列驱动动画，FightLoop 播完进入下一轮选技能。
// updates：p_update 数组（type=1 刷新技能剩余次数 power_point，客户端 dealUpdateData 直接改技能栏）
// batchIdx（1 起）：多波 BOSS 战的当前波；batch>1 时我方不带进场（已在场，只进敌方新波）
function pushFightRound(conn, fightId, round, fightList, batchIdx, updates, roundEffects) {
  updates = updates || [];
  roundEffects = roundEffects || [];
  let enterList = [];
  let oppNum = 0;
  if (round === 1) {
    const batch = batchIdx || 1;
    // 我方：编队主力按阵型站位进场（batch>1 转场续战时我方在场，不重复进）
    const allies = [];
    let benchIdsSnap = []; // 替补快照（batch===1 块内填充，S.fightState 赋值处消费）
    if (batch === 1) {
      const lastId = (S.mapState && S.mapState.lastId) || 1;
      const f = buildFormation(lastId, S.formations[lastId]);
      const fieldIds = f.field.filter(id => id > 0);
      // 替补（备战位）快照（二百八十二·续 G）：不进场不站格、不吃回合结算，整场待命；
      // 主力阵亡后于下一回合开始上位（顶替者按所顶格的阵型加成重建）。进单位时才 mkAllyUnit，
      // 这里只快照 ids（与 field 重复的脏数据剔除——同 id 双进场会让客户端战斗账本错乱）。
      benchIdsSnap = (f.bench || []).filter(id => Number(id) > 0 && !fieldIds.includes(Number(id)));
      fieldIds.forEach((sid, i) => {
        const b = S.servants.find(s => s.id === sid);
        if (b) {
          // 阵型加成：站在启用格上的第 j 个誓灵获得该阵型 effect[j]（CfgCopy.arrays 同规则）
          const eff = effectOfSlot(f.lineup, f.positions[i]) || { dmg: 0, selfMit: 0, teamMit: 0, dodge: 0 };
          const unit = mkAllyUnit(b, TILE_OF_POS[f.positions[i]] || [-2, 0], eff, lastId);
          // 替补上位时按所顶替的主力格重建同款加成：把站位/加成记在单位上（内部字段，不进包）
          unit.fieldPos = f.positions[i];
          unit.slotEff = eff;
          allies.push(unit);
          enterList.push(fightServantOf(b.id, b.type, unit.nature, briefPosOf(f.positions[i]), {
            usingIds: usingSkillsOf(b), learnedIds: b.learned_skills, level: unit.level,
            energyPoints: b.energy_points || null, overstep: b.overstep || 0,
            coreBonus: allyEquipBonusOf(b, lastId), lineupEff: eff, ally: true,
            star: EV.normStar(b.star), // 种族值档位随星级（与 mkAllyUnit / 客户端面板同源）
            skin: Number(b.skin_id) || 0, // 真实当前皮肤（进化皮随 star；战斗立绘/小人形态唯一来源）
            attrsOverride: unit.attrs,
            statLevels: unit.statLevels, buffs: unit.buffs,
            talent: unit.talent, relicId: unit.relicId,
            shield: unit.shield || 0, // 开场护盾（圣器）随进场包下发
            element: unit.element,    // 元素精灵（未装备为 undefined → 发空数组）
            bid: bidOfAlly(unit, S.fightState), // 客户端战斗 id（wire id；内部 id 仍是真实誓灵 id）
          }));
        }
      });
    } else if (S.fightState && S.fightState.allies) {
      // 转场续战：保留余血与已耗技能次数
      S.fightState.allies.forEach(a => { if (a.hp > 0) allies.push(a); });
    }
    // 敌方：按当前战斗点当前波取阵容，镜像站位 x 取反。
    // 誓灵类敌人最多 3 个（前排 x=2/3），量产型 monster 小怪排后排补充位（x=3 剩余格），可超过 3 个。
    const copyId = S.fightState && S.fightState.copyId;
    const batches = fightBatches(S.fightState);
    const wave = (batches[batch - 1] || batches[0] || []).slice(0, 6);
    const TILES_BY_COUNT = {
      1: [[2, 0]],
      2: [[2, -1], [2, 1]],
      3: [[2, -1], [2, 1], [3, 0]],
      4: [[2, -1], [2, 1], [3, 0], [3, 1]],
      5: [[2, -1], [2, 0], [2, 1], [3, -1], [3, 1]],
      6: [[2, -1], [2, 0], [2, 1], [3, -1], [3, 0], [3, 1]],
    };
    const tiles = TILES_BY_COUNT[wave.length] || TILES_BY_COUNT[3];
    const enemies = [];
    wave.forEach((e, i) => {
      const unit = assignEnemyBid(mkEnemyUnit(e, i, tiles[i]), S.fightState);
      enterList.push(fightServantOf(unit.id, e.type, unit.nature, briefPosOf(tiles[i]), {
        level: unit.level, hpOverride: unit.maxHp, usingIds: null,
        statLevels: unit.statLevels, buffs: unit.buffs,
        talent: unit.talent, relicId: unit.relicId,
        bid: unit.bid, // 客户端战斗 id（wire id）
      }));
      enemies.push(unit);
    });
    if (S.fightState) {
      S.fightState.allies = allies;
      S.fightState.enemies = enemies;
      if (batch === 1) {
        S.fightState.teamId = (S.mapState && S.mapState.lastId) || 1;
        S.fightState.weather = S.fightState.weather || { start_weather: 0, weather_end_round: 0 };
        S.fightState.benchIds = benchIdsSnap;
        S.fightState.pendingEnters = [];
        S.fightState.standRemovals = [];
      }
    }
    oppNum = wave.length;
    // 活动助战（1105）：第一波应用全量效果 + 助战登场；后续波只补"每敌首次受伤"标记
    // （折纸对转场后的新一波敌人同样生效，其余三条只在"战斗开始"触发）。
    // ⚠️ 顺序依赖：必须放在 enter_list 构建**之后**。fightServantOf 会把 statLevels 读成
    // attr.phy_atk_lv 等数字写进进场包；若先加等级再建 enter_list，客户端进场就是 +1，
    // 再吃 effect_list 的 100000 会变成 +2（两端不一致）。
    {
      const as = activeAssist(S.fightState && S.fightState.copyId);
      if (as) {
        if (batch === 1) {
          const lines = applyAssistStart(as, allies, enemies, roundEffects);
          applyAssistVuln(as, enemies);
          // 助战登场：客户端唯一入口 = 回合包 update 的 type=4（FightMgr.dealUpdateData）。
          // id=0 才是我方（asm 实证；反编译 `slot5.id == 0 == false` 是条件反转），
          // val = CfgMonster.assist 的 key（= DATA_ALIVE.servants[].skinId）。
          updates.push({ type: 4, id: 0, id2: 0, val: as.helpId, vals: [] });
          if (S.fightState) S.fightState.assist = { id: as.id, helpId: as.helpId, name: as.name };
          log(`[fight] 助战 ${as.name}(id=${as.id} helpId=${as.helpId}) 生效：${lines.join('，')}`);
        } else if (as.kind === 'vuln') {
          applyAssistVuln(as, enemies);
          log(`[fight] 助战 ${as.name} 波${batch}：新一波敌人挂首次受伤 +${Math.round(as.mul * 100)}%`);
        }
      }
    }
    // 三百一十三·续：入场天赋/天气/圣器共享提前到**战斗开始**——首包 effect_list 的 phase=1 演出
    // 由客户端 startRound→dealFeatureData + onBatchEnd→checkFeature(TRIGGER_TIME_BORN) 在单位走入+
    // 波次横幅后、选技前连播（调研-凡赛堤审判法典.md §9）。原先只在首次 select 结算 ⇒ 演出全部
    // 落到第一回合动作播完之后。位置必须在 enter_list 构建**之后**（苏摩扣血/青龙施技等以 effect
    // 增量下发，enter 包保持入场前状态——与上方助战的顺序纪律同源）；settleRoundStartTalents 保留
    // 同三连兜底（flag 幂等，替补等后进场单位仍走其入场那一包）。
    {
      const startUnits = (S.fightState.allies || []).concat(S.fightState.enemies || []);
      const startFx = FC.settleBattleStartTalents(startUnits, S.fightState);
      if (startFx.length) roundEffects.push(...startFx);
      // 21680 十香：开局减防在 entry 包下发（玩家选第一个技能前就能看到）
      const tenkaStart = FC.applyTenkaOpeningDebuff(startUnits, 1);
      if (tenkaStart.length) roundEffects.push(...tenkaStart);
    }
    log(`[fight] 波${batch} 回合1 进场 copy=${copyId}：我方 ${allies.length} + 敌方 ${oppNum}（${enemies.map(e => `lv${e.level} hp${e.maxHp}`).join(',')}）`);
  }
  // 天气自然回合到期重置
  if (S.fightState && S.fightState.weather && S.fightState.weather.start_weather > 0) {
    if (S.fightState.weather.weather_end_round > 0 && round > S.fightState.weather.weather_end_round) {
      S.fightState.weather = { start_weather: 0, weather_end_round: 0 };
    }
  }
  // wire id 映射（一百八十八 方案 A'）：effect_list 里的 atk/src/tar 与 update[].id 都是引擎
  // 内部 id → 下发前统一换成客户端战斗 id（bid）。此处是主线战斗 effect 的唯一出口，
  // 四个 effect 产生点（startTalents/applySkillEffects/checkTalentsAfterSkill/endTicks）全覆盖。
  const stAll = (S.fightState && S.fightState.allies) || [];
  const stEns = (S.fightState && S.fightState.enemies) || [];
  const wireMap = {};
  stAll.concat(stEns).forEach(u => { wireMap[u.id] = bidOfUnit(u); });
  const toWire = n => wireMap[n] != null ? wireMap[n] : n;
  // 最后一道闸：属性类 effect 里 delta=0 的条目（能力等级已 ±6 上限 / 后土把降级吃掉 /
  // 重置技写死 0）客户端渲染时一定 printError("能力等级变化为0")，且不会改变任何数值。
  // 四个产生点内部已各自过滤（fight_core.flattenEffects），这里兜住
  // settleSkill.wakeEffects 等绕过那四个出口的路径。
  const wireEffects = (roundEffects || [])
    .filter(e => !FC.isZeroAttrChange(e))
    .map(e => FC.sanitizeEffectTargets(e))
    .map(e => Object.assign({}, e, {
      atk_servant_id: toWire(e.atk_servant_id),
      src_servant_id: toWire(e.src_servant_id),
      tar_servant_ids: (e.tar_servant_ids || []).map(toWire),
    }));
  // 替补登场（二百八十二·续 G）：上一回合/上一波排队的 enter 载荷随本包下发（死亡发生在
  // 已推的回合包里，同包 born 会 replaceUnit 掉还没播死动画的活人）；
  // stand_list = 当前待命替补（客户端 addOutServant 按 id 去重），remove = 已上位者（延迟一包生效）。
  {
    const pend = S.fightState && S.fightState.pendingEnters;
    if (pend && pend.length) enterList.push(...pend.splice(0, pend.length));
  }
  conn.sendToc('m_fight_servant_fight_toc', {
    fight_id: fightId,
    fight_type: 0,
    fight_round: round,
    round_start: round === 1 ? 1 : 0,
    fight_list: fightList || [],
    enter_list: enterList,
    summon_List: [],
    stand_list: buildStandList(),
    remove_stand_list: (S.fightState && S.fightState.standRemovals) ? S.fightState.standRemovals.splice(0, S.fightState.standRemovals.length) : [],
    effect_list: wireEffects,
    opp_servant_num: oppNum || (S.fightState && S.fightState.enemies ? S.fightState.enemies.filter(e => e.hp > 0).length : 0),
    update: (updates || []).map(u => Object.assign({}, u, { id: toWire(u.id) })), // wire id（客户端按 id 查单位刷 PP）
    // weather 必须发单对象（104 嵌套）：客户端 updateWeatherInfo 直接读 .start_weather/.weather_end_round
    weather: (S.fightState && S.fightState.weather) || { start_weather: 0, weather_end_round: 0 },
    spec_type: '',
    spec_value: [],
    update_attr_list: [],
    // 元素唤醒：1=本场还可唤醒（且我方确有人装备了元素精灵）、0=已用过/无人装备
    element_wake_times: elementWakeTimesOf(S.fightState),
    select_time: Math.floor(Date.now() / 1000) + 30, // 选技能倒计时截止时间戳
  });
}

// EX 星条件：按 CfgCopyDetail extraCondition 逐条计算（客户端 dealShowStar 读 star[{id,val}]，
// id=条件序号 1..3）。类型语义（CfgCopy.extraCondition 字符串表）：1=通关副本 / 6=#1回合内胜利 /
// 11=力尽誓灵数不超过#1 / 18=击倒『本影』以外所有敌人 / 20=战胜隐藏BOSS。
// 回合口径=当前波次计数（S.fightState.round 每波重置）；力尽=st.allies 中 hp<=0（含替补）。
// 14 关全部 EX 波次条目实测 = {1} + {6,8} + {11,3}（CfgCopyDetail 提取，gen_ex_config.js ecWaves）
function exStars(cfg, st, copyId) {
  const ec = (cfg.ecWaves && cfg.ecWaves[copyId]) || [];
  if (!ec.length) return null;
  const rounds = st.round || 1;
  const deaths = (st.allies || []).filter(a => a.hp <= 0).length;
  const chainDead = isMapCleared(cfg, (S.mapState && S.mapState.defeated) || []);
  const shadowDead = !!(S.mapState && S.mapState.barrierId && progressOf(S.mapState.barrierId).shadowDefeated);
  return ec.map((c, i) => {
    const type = c[0], arg = c[1];
    let val = 1;
    if (type === 6) val = rounds <= arg ? 1 : 0;
    else if (type === 11) val = deaths <= arg ? 1 : 0;
    else if (type === 18) val = chainDead ? 1 : 0;
    else if (type === 20) val = shadowDead ? 1 : 0;
    return { id: i + 1, val };
  });
}

// 推战斗结算（CopyResultVO.initByFightResult 直读字段；mvp_stats/replace_list/servant_exp 必须是数组）
// 掉落：onBattleWon 首通时把 dropServant 存到 S.fightState，这里随结算下发（结算面板播誓灵获得展示）
// 经验：编队全员（参战主力存活全额/阵亡减半，替补席未阵亡全额同量）实得经验 → 结算 servant_exp 展示 + 落账 + m_servants_change_toc 刷 VO
// 满级誓灵即便 gained===0 也必须下发 { id, val: 0, type: 0 }，保证 CopyRewardPanel 正常出场展示并显示“经验+0”
function pushFightResult(conn, fightId, afterResult) {
  const st = S.fightState || {};
  const copyId = st.copyId || currentFightPoint();
  const cfgFR = mapCfg(); // 星条件取当前关配置（EX ecWaves）
  // 战斗经验：基础 30 + 每杀 20（1-1 道中 3 怪=90、BOSS 战多波更高；1→2 级需 100）
  // doubleMul 由 onBattleWon 定（主线双倍生效的整关通关为 2，其余 1）——誓灵经验与指挥官经验同样翻倍
  const dblMul = st.doubleMul || 1;
  const kills = (st.enemies || []).length;
  // 专注加倍（星图节点 43）：主线/活动副本战斗誓灵经验 +1%/级（CfgGrow des"在主线和活动副本内
  // 战斗获得经验提升X%"，官方指誓灵经验；指挥官经验另算）
  const focusMul = 1 + 0.01 * require('./grow').starLv(43);
  // 玄之书族（15004001~4）：携带者获得经验 +5/8/11/15%。按**每只誓灵自己**的圣器算，
  // 所以在下方逐人结算时乘各自的 expMul（见 b.expMul 读取处）。
  const expBase = Math.round((30 + kills * 20) * dblMul * focusMul);

  // 1. 获取当前出战编队（主力 + 替补），确保 6 人全员按顺序结算出场
  const teamId = (st && st.teamId) || (S.mapState && S.mapState.lastId) || 1;
  const f = buildFormation(teamId, S.formations[teamId]);
  const fieldIds = (f.fight_field || f.field || []).filter(id => id > 0);
  const benchIds = (f.fight_bench || f.bench || []).filter(id => id > 0);

  const allServantEntries = []; // { id, isBench: boolean }
  const seenIds = {};
  for (let i = 0; i < fieldIds.length; i++) {
    const id = fieldIds[i];
    if (!seenIds[id]) {
      seenIds[id] = true;
      allServantEntries.push({ id: id, isBench: false });
    }
  }
  for (let i = 0; i < benchIds.length; i++) {
    const id = benchIds[i];
    if (!seenIds[id]) {
      seenIds[id] = true;
      allServantEntries.push({ id: id, isBench: true });
    }
  }
  const alliesList = st.allies || [];
  for (let i = 0; i < alliesList.length; i++) {
    const a = alliesList[i];
    if (a && a.id > 0 && !seenIds[a.id]) {
      seenIds[a.id] = true;
      allServantEntries.push({ id: a.id, isBench: false });
    }
  }

  // 2. MVP 统计行与推选：score（伤害+治疗）最高者当选，并列取场上靠前（pickMvp 严格大于保持先者）。
  //    全 0（极端理论态）回退"存活等级最高"原链，避免从背包盲选挂空（调研-结算详情页.md §4.3）
  const mvpRows = FS.buildRows(st.mvpStats, alliesList, S.servants);
  let mvp = FS.pickMvp(mvpRows);
  if (!mvp) {
    const aliveAllies = alliesList.filter(a => a.hp > 0);
    if (aliveAllies.length > 0) {
      const best = aliveAllies.slice().sort((a, b) => (b.level || 0) - (a.level || 0))[0];
      mvp = best.id;
    } else if (alliesList.length > 0) {
      mvp = alliesList[0].id;
    } else if (fieldIds.length > 0) {
      mvp = fieldIds[0];
    } else if (allServantEntries.length > 0) {
      mvp = allServantEntries[0].id;
    } else if (S.servants.length) {
      mvp = S.servants[0].id;
    }
  }

  const servantExp = [];
  const changes = [];
  allServantEntries.forEach(entry => {
    const b = S.servants.find(s => s.id === entry.id);
    if (!b) return;
    const ally = alliesList.find(x => x.id === entry.id);
    // 参战主力存活全额、阵亡减半；替补席未参战未阵亡，获得同量全额经验
    let gained = (!entry.isBench && ally && ally.hp <= 0) ? Math.floor(expBase / 2) : expBase;
    // 玄之书族：携带者的经验加成（每人自己的圣器）
    const relicExpMul = relicBonusOf(b, S.bagGoods).expMul || 0;
    if (relicExpMul > 0) gained = Math.round(gained * (1 + relicExpMul));
    // MVP 加成（BWIKI 官方口径 1.2 倍，wiki「除非拥有MVP加成(1.2倍)或受装备圣器」）：
    // 乘在圣器加成之后、最后一次取整（调研-结算详情页.md §5 D2）
    if (entry.id === mvp) gained = Math.round(gained * FS.MVP_EXP_MUL);
    const r = TRAIN.applyServantExp(b, gained);
    // 满级誓灵：溢出经验按 CfgDorm.study[4] 的转化率存入协会时光银行（二百一十六）。
    // 必须**逐只**入账（转化率随银行等级，而银行等级随繁荣度，同一场内不会变，但口径要一致）。
    if (r.overflow > 0) {
      try { require('./dorm').bankDeposit(r.overflow); } catch (e) { /* 银行异常不阻塞结算 */ }
    }
    // 关键：即便满级 r.gained === 0，也必须推入 servantExp 下发 { id, val: 0, type: 0 }
    // 客户端 checkServantShow(id) 读 servantExps[id]，在 Lua 中 0 为真值，从而正常出场展示并显示“经验+0”
    servantExp.push({ id: entry.id, val: r.gained, type: 0 }); // type 0=TYPE_EXP_NORMAL
    if (r.gained > 0) {
      changes.push({ servant_id: entry.id, key: CHANGE_ID_EXP, val: r.exp });
      if (r.level !== r.oldLevel) changes.push({ servant_id: entry.id, key: CHANGE_ID_LEVEL, val: r.level });
    }
  });

  // 指挥官经验：随章节难度 + 击杀数（曲线见 data/role_level_data.js）。
  // 推送时序照 CopyRewardPanel.updateExpInfo 动画：exp_change 必须先于结算包（面板以新 GlobalData.exp
  // 为动画终点），levelup 推在结算包后（面板 "Lv" 标签显示升级前等级）
  const roleGain = ROLE_LEVEL.battleRoleExp(copyId, kills) * dblMul;
  const roleR = applyRoleExpGain(roleGain);
  pushRoleExpChange(conn);
  log(`[fight] 结算：胜利 fight=${fightId} copy=${copyId} mvp=${mvp} 掉落=${st.dropServant ? st.dropServant.id : '无'} 誓灵经验=${expBase}/人（${servantExp.length}只出场，主力${fieldIds.length}+替补${benchIds.length}） 指挥官经验=+${roleGain}${roleR.leveledUp ? `（升级 Lv${roleR.oldLevel}→Lv${roleR.level}）` : ''}${dblMul > 1 ? ' ×双倍' : ''} MVP统计(伤害/治疗/承伤)=[${mvpRows.map(r => `${r.id}:${r.atk}/${r.hp_recover}/${r.hp_reduce}`).join(' ')}]`);
  // 星云点（御灵士星图）：按当次所有誓灵实得经验的 1/750 额外转化（不扣经验），周上限 1000。
  // 放在 servantExp 累计之后——用实得值（阵亡减半已计入），战斗结束后客户端打开星图即见新值
  require('./grow').gainNebula(conn, servantExp.reduce((s, x) => s + x.val, 0));
  conn.sendToc('m_fight_result_toc', {
    fight_id: fightId,
    copy_id: copyId,
    result: 1, // FightConst.RESULT_WIN
    mvp,
    // 星条件：EX 按配置实算（8 回合内/力尽≤3 可败）；普通关维持全三星（其 EC 含 2/3/5 等未跟踪类型）
    star: (cfgFR.ex && exStars(cfgFR, st, copyId)) || [{ id: 1, val: 1 }, { id: 2, val: 1 }, { id: 3, val: 1 }],
    gold: 0,
    // 结算面板的金币展示项。曜日副本的金币由 daily_copy.settleRewards 按关档发放（3000/8000/20000）
    // 并已推过 m_role_attr_change_toc，这里回它的实发值；主线是固定展示 100
    silver: st.silverReward != null ? st.silverReward : 100,
    role_exp: roleGain, // 结算面板 "EXP+N" 标签 + 经验条动画回推量
    servant_reward: st.dropServants || (st.dropServant ? [st.dropServant] : []), // p_kvt{id:誓灵type, val:数量, type:1新获得}
    // p_reward{type:道具id, num}：曜日副本的材料掉落（onBattleWon → daily_copy.settleRewards 已入包，
    // 这里只是结算面板展示）。**必须是真实道具 ID**——CfgCopyDetail.reward 里的 31000006/7/8
    // 是「进化材料1/2/3」展示聚合道具，本身不能用于进化
    item_reward: st.itemRewards || [],
    servant_exp: servantExp, // p_kvt{id:誓灵id, val:经验, type:0普通}——结算面板经验条动画数据源
    kill_num: kills,
    // 结算详情页数据源（p_fight_stats{id,skin_id,name,atk,hp_recover,hp_reduce,score}）：
    // 参战我方按场上顺序、7 字段全量显式发（客户端拿 max 字段做分母，缺字段=Lua nil 崩）
    mvp_stats: mvpRows,
    score: 0,
    add_score: 0,
    replace_list: [],
  });
  // VO 刷新推在结算包之后（面板动画以 VO 旧经验为起点，推早了动画起点就是新值）。
  // afterResult 钩子：胜利结算要把 scene_result 插到这两包**之间**之后（背靠背），
  // 否则真机 fsync/推送延迟让客户端在动画播完时读不到结果 → 误报「网络问题」。
  if (afterResult) afterResult();
  if (changes.length) pushServantChanges(conn, changes);
  if (roleR.leveledUp) pushRoleLevelup(conn);
  saveState();
}

// 最终波胜利结算的收尾两连发：m_fight_result_toc（结算面板数据）与 m_fight_scene_result_toc
// （FightMgr 预存 WIN）之间只允许背靠背——客户端 onFightLoopEnd2 播完最后一波动画就调
// onFightBatchEnd(checkResult())，checkResult 读 scene_result 预存；两包间隔被经验/VO/星云等
// 推送拉开（真机实测 914ms）时 checkResult()==nil → 误报「由于网络问题导致战斗结果还没收到」
// （2026-10-12 12:14:27 实证，功能无损纯误报）。scene_result 必须紧贴 result_toc。
// 2026-10-17 复发：promise 化修好了顺序，但 pushFightResult 内部仍有同步 saveState
// （本函数第 440 行 + gainNebula），真机 fsync 500~950ms 把两包重新拉开到 1.18s。
// 解法：整段结算放进 batchWrites 事务——期间所有 saveState 只记脏，退出时合并写一次。
function pushFinalWinResults(conn, fightId) {
  batchWrites(() => {
    pushFightResult(conn, fightId, () => {
      conn.sendToc('m_fight_scene_result_toc', { fight_id: fightId, result: 1 });
    });
  });
}





// 存活的怪物节点（未击败的）
function aliveMonsterNodes() {
  const defeated = (S.mapState && S.mapState.defeated) || [];
  const cfg = mapCfg();
  const alive = cfg.monsterChain.filter(m => !defeated.includes(m));
  // 影 BOSS（EX 本影 / 主线 11 章"？？？"）：链外打点（不进 monsterChain/击杀计数/全清判定），存活时走上去同样接敌
  const shadowPos = (cfg.ex && cfg.ex.hlBossPos) || (cfg.shadow && cfg.shadow.pos);
  if (shadowPos && !(progOfShadow(cfg) || {}).shadowDefeated) alive.push(shadowPos);
  return new Set(alive);
}
// 本影击败态：会话优先，落档在 progressOf(barrierId).shadowDefeated（重进图不复活）
function progOfShadow(cfg) {
  return (S.mapState && S.mapState.barrierId) ? progressOf(S.mapState.barrierId) : null;
}

// 按事件链进度生成地图对象可见性：
// 存活怪全部可见（val=1）、已击败隐藏（val=0）。
// 注意不能只显示"链上下一只"：monster_list 会下发全部怪格，客户端踩上去就接敌，
// 隐藏的存活怪表现为"看不见但能打起来的怪"（3-1 相邻两怪实测）。雾在对应怪被击败前保持可见
function mapObjList() {
  const cfg = mapCfg();
  const defeated = (S.mapState && S.mapState.defeated) || [];
  const objs = cfg.monsterChain.map(m => ({ id: m, type: 2, val: defeated.includes(m) ? 0 : 1 }));
  // fogAfter 值支持数组（同一触发怪消散多片雾，10-4 模式）；数值键在 JS 对象里本来就是字符串。
  // 键=影点（11 章雾恰好各罩一片"？？？"）时，消散判据是 shadowDefeated 而非链 defeated
  for (const [mon, fogs] of Object.entries(cfg.fogAfter)) {
    const triggerDead = defeated.includes(Number(mon))
      || !!(cfg.shadow && Number(mon) === cfg.shadow.pos && S.mapState && S.mapState.barrierId
        && progressOf(S.mapState.barrierId).shadowDefeated);
    for (const fog of [].concat(fogs)) {
      objs.push({ id: fog, type: 5, val: triggerDead ? 0 : 1 });
    }
  }
  // 本影立绘（hlboss.stand spine）：存活显形（val=1）、击败隐藏。客户端 monster_list 绑定该格
  // 接敌（MapVO.copy 对 monster_list 只查 getNode，不要求 type=2 物件——调研 §3.2）
  if (cfg.ex && cfg.ex.hlBossPos) {
    const shadowDead = !!((S.mapState && S.mapState.barrierId && progressOf(S.mapState.barrierId).shadowDefeated));
    objs.push({ id: cfg.ex.hlBossPos, type: 7, val: shadowDead ? 0 : 1 });
  } else if (cfg.shadow && cfg.shadow.pos) {
    // 主线 11 章"？？？"影 BOSS：CfgMap 有实体怪物件（skin=签名敌模型），按普通怪 type=2 下发
    const shadowDead = !!((S.mapState && S.mapState.barrierId && progressOf(S.mapState.barrierId).shadowDefeated));
    objs.push({ id: cfg.shadow.pos, type: 2, val: shadowDead ? 0 : 1 });
  }
  // 链外官方战斗点显式隐藏（2026-10-24，10-4 幻影怪）：客户端 MapVO.copy 只覆盖 obj_list
  // 里出现的 id（MapVO.lua:100-106），名单外物件按 CfgMap initVisible 渲染 ⇒ 官方战斗点数
  // > wiki 道中数的关（5~10 章 15 张）会残留"永远显示但接不了敌"的怪（10-4 30010、5-2
  // 32026/42018）。不可走节点上的 initVisible=true 远景怪是官方装饰（7-2/8-1），不在表里、保留显示。
  for (const id of HIDDEN_MONSTER_OBJS[cfg.mapId] || []) objs.push({ id, type: 2, val: 0 });
  return objs;
}

// ---- 跨区域传送（3-5 章多分量地图）----
// 客户端 trans_point 只喂寻路（MapVO.initAreaTranfsers + AStar 跨 area），真正的位移由服务端
// 推 m_map_transfer_toc{pos} 完成；配置只写单向，反向自动补（否则过去了回不来）
function transEdges(cfg) {
  const out = [];
  for (const t of cfg.transPoints || []) {
    out.push({ id: t.id, val: t.val, from: t.from || 0, to: t.to || 0 });
    out.push({ id: t.val, val: t.id, from: t.to || 0, to: t.from || 0 });
  }
  return out;
}

// 玩家当前所在区域（只能经传送点切换，故记在 mapState 里；老存档/单分量图恒 0）
function curZone() {
  return (S.mapState && S.mapState.zone) || 0;
}

function aliveInZone(cfg, zoneIdx) {
  const zones = cfg.zones || [];
  const defeated = (S.mapState && S.mapState.defeated) || [];
  const z = zones[zoneIdx];
  if (!z) return cfg.monsterChain.filter(m => !defeated.includes(m));
  return z.monsters.filter(m => !defeated.includes(m));
}

// 自动搜寻敌人的目标列表（客户端 MapVO.getFindMonster 按下标取，寻路失败会自动试下一只）：
// 当前区域的存活怪优先，其余区域垫后
function pushFindMonster(conn) {
  const cfg = mapCfg();
  if (!cfg) return;
  const defeated = (S.mapState && S.mapState.defeated) || [];
  const near = aliveInZone(cfg, curZone());
  const rest = cfg.monsterChain.filter(m => !defeated.includes(m) && !near.includes(m));
  conn.sendToc('m_map_find_monster_toc', { monster_id: near.concat(rest) });
}

// 当前区域已清空但别的区域还有怪 → 把玩家挪到下一区域入口（区域图 BFS 取第一跳）。
// 首通时客户端"自动搜寻敌人"未解锁（isOpenAutoFindMonster 要求已拿额外星），
// 传送格又没有任何视觉提示，手动玩家找不到传送点会卡死在角落 → 进图时兜底搬运
function relocateIfCleared(cfg) {
  if (!S.mapState || !(cfg.zones || []).length) return false;
  let moved = false;
  for (let guard = 0; guard < cfg.zones.length; guard++) {
    if (aliveInZone(cfg, curZone()).length) break;
    const target = cfg.zones.findIndex((z, i) => i !== curZone() && aliveInZone(cfg, i).length);
    if (target < 0) break;
    // 区域图 BFS：从当前区域找到通往 target 的第一跳传送边
    const edges = transEdges(cfg);
    const prev = new Map([[curZone(), null]]);
    const queue = [curZone()];
    while (queue.length) {
      const z = queue.shift();
      if (z === target) break;
      for (const e of edges) {
        if (e.from === z && !prev.has(e.to)) { prev.set(e.to, e); queue.push(e.to); }
      }
    }
    if (!prev.has(target)) break;
    let hop = prev.get(target);
    while (prev.get(hop.from)) hop = prev.get(hop.from); // 回溯到第一跳
    S.mapState.pos = hop.val;
    S.mapState.zone = hop.to;
    moved = true;
    log(`[map] 区域 ${hop.from} 已清空 → 传送到区域 ${hop.to} 入口 ${hop.val}`);
  }
  if (moved) saveState({ defer: true });
  return moved;
}

// 推送 m_map_enter_toc 进入冒险小地图
// 目前只实现了主线 1-1（CfgMap_1010100）的地图数据，其他 barrier 复用兜底
function pushMapEnter(conn, barrierId, lastId, opts = {}) {
  // 存档编队的 S.servants 可能 attr 缺失（客户端提交的原样），地图血条要 .hp/.max_hp → 统一兜底
  const fullAttr = Object.assign(defaultFill('p_attr'), {
    hp: 1000, max_hp: 1000,
    phy_atk: 120, mag_atk: 120, phy_def: 60, mag_def: 60,
  });
  // 单支编队的 map_enter 载荷：统一从规整后的 field/bench 重新生成 servants
  //（保证 is_field 与槽位一致，且 attr 带血量）；tid = 该编队号，编队誓灵带的是
  // 这套队伍的信仰配装 faithTeams[tid]——多队下发时必须各队各取，不能都挂 lastId
  const formationPayload = (tid) => {
    // 当前队保留旧行为（编队缺失回落队1）；其余出战队缺失一律空编队——回落队1会把队1
    // 阵容复制进别队的 map_enter 载荷（客户端按 index 渲染 ⇒ 队2 显示队1的誓灵）
    const tf = S.formations[tid] || (Number(tid) === (Number(lastId) || 1) ? (S.formations[1] || {}) : {});
    const tField = normSlots(tf.field), tBench = normSlots(tf.bench);
    let ts = tField.filter(id => id > 0).map(id => teamServantOf(id, 1, tid))
      .concat(tBench.filter(id => id > 0).map(id => teamServantOf(id, 0, tid)))
      .filter(Boolean);
    ts = ts
      .map(s => (!s.attr || Array.isArray(s.attr) || s.attr.hp == null)
        ? Object.assign({}, s, { attr: Object.assign({}, fullAttr, !Array.isArray(s.attr) && s.attr || {}) })
        : s);
    return Object.assign(buildFormation(tid, tf), { servants: ts });
  };
  // team 数组下发**全部**出战编队（客户端按数组消费，零改动激活官方多队表现）：
  // - MapVO.copy: teamNum = #team ⇒ 换队按钮按 teamNum>1 显隐（此前恒单队 ⇒ 按钮永不出现）
  // - AdventureModule.m_map_enter_toc 遍历 team 刷各队 VO；select_team 定当前队
  // - 点换队循环 nowTeamList（init_barrier_toc.use_team_ids）发 select_tos ⇒ collab.js
  //   跟随更新 S.mapState.lastId ⇒ 后续接敌/结算自动用新队（二百八十二·续 C）
  // 症状存照（2026-11-06 用户矩阵）：{1,3} 与 {1,2} 在小地图上显示完全相同——地图上永远
  // 只有先选的那一队，用户把队1的主3+补3头像组读成"1、2两队"。
  const ms0 = S.mapState;
  const ids = [...new Set(((ms0 && ms0.use_team_ids) || []).map(Number))].filter(id => id > 0);
  if (!ids.length) ids.push(lastId || 1); // 无会话上下文（理论不可达）回落单队
  if (!ids.includes(Number(lastId) || 1)) ids.unshift(Number(lastId) || 1); // select_team 必须在数组内
  const cfg = MAP_CONFIGS[barrierId] || MAP_CONFIGS[1010100];
  relocateIfCleared(cfg); // 当前区域清空 → 先把玩家挪到下一区域入口，再出 pos
  conn.sendToc('m_map_enter_toc', {
    map_id: cfg.mapId, // 客户端按 CfgMap_<id> 加载地图，必须与关卡一致
    skin: 0,
    pos: (S.mapState && S.mapState.barrierId === barrierId && S.mapState.pos) || cfg.bornPos, // 上次所在格（战斗后回位），首次出生点
    areas: [{ id: 0, val: 1 }, { id: 1, val: 1 }, { id: 2, val: 1 }, { id: 3, val: 1 }], // 区域全开（1040100 有 area3）
    obj_list: mapObjList(), // 存活怪全部可见/已击败隐藏/雾按进度
    trans_point: transEdges(cfg), // 跨区域传送点（含自动补的反向），喂客户端 AStar 跨 area 寻路
    monster_list: cfg.monsterChain.map(m => ({ id: m, list: [m] }))
      .concat(cfg.ex && cfg.ex.hlBossPos ? [{ id: cfg.ex.hlBossPos, list: [cfg.ex.hlBossPos] }] : [])
      .concat(cfg.shadow && cfg.shadow.pos ? [{ id: cfg.shadow.pos, list: [cfg.shadow.pos] }] : []),
    team: ids.map(formationPayload), // 全部出战编队；index=队伍号，select_team 指当前队
    select_team: lastId,
    monster_id: 0,
  });
  // 2026-10-18 一百九十二：放弃战斗回图**不能**随 map_enter 推 find_monster。
  // 真机（PCJS 模拟器 14_48/15_43 会话）实证：cancel 四连包 cancel→气泡→pause(1)→enter→
  // find_monster→pause(0) 里，find_monster 到达时客户端仍在处理 enter（onMapEnterToc 的
  // "从战斗进入"分支只挡了 onMapEnterToc 内部的 isInAutoMove 写回，但 find_monster_toc →
  // setFindID → ON_FIND_MONSTER_CHANGE → MapScene.checkAutoMove 是另一条独立链，其守卫是
  // **AdventureMgr.isInAutoMove 本身**——而 m_fight_cancel_toc 是在收到 cancel_toc 时置 false，
  // 但 PCJS 上 PS-CANCEL-SENT auto=true 实证 cancel_toc 处理序里它先被 enter 链写回 true
  // （上一轮 enter_toc 的 uv0 分支只跳过"新进入地图"分支，可 15_43 会话第一次 cancel 时
  // PS-CANCEL-SENT auto=true，说明初战接敌前的 getCopyAutoState 已置 true，而 uv0 分支
  // 恰恰**保留**了这个 true）。于是 checkAutoMove 命中 find_monster 分支 → gotoNode(34014)
  // → move_path×N → dst → 又一场 fight_prepare：表现即"放弃后立刻又扑向下一只怪"。
  // 正常进图路径（init_barrier / m_map_enter_tos）行为不变——那时要么玩家刚点"出击"
  // （CopySortiePanel 置 false 或 CopyLeverPanel 置 true，均属玩家本意），要么是战斗胜利
  // 续寻（官方语义）。
  if (!opts.skipFindMonster) pushFindMonster(conn);
  // 击杀进度必须随进图主动推：全清收尾后地图面板是被 onInactive 移出（不是 close），
  // 再进新关时 onOpen 走 false 分支不再发 m_copy_monster_num_tos，只靠 onGUI 读
  // AdventureMgr 的旧计数 → 会一直显示上一关的 4/4，直到第一只怪被打死。
  pushMonsterNum(conn, barrierId);
}



// EX 每日次数登录全量：⚠️ m_activity_daily_toc 客户端消费是 **initDailyTimes = 整表替换**
// （RoleMgr_ljd.lua:41 dailyDic = table.toDic(actives)），单独发 20004 条目会把 daily_copy
// 在 2600ms 推的 20001~20003 清掉 ⇒ 必须合并全量（曜日条目 + EX 条目）后一次发。
// 时序挂 role.js 登录链 2650ms（晚于 daily_copy.onLogin，最终态=合并集）。
function exDailyLoginPush(conn) {
  const actives = require('./daily_copy').dailyEntries().slice();
  const exEntry = exDailyLoginEntry();
  const i = actives.findIndex(a => a.id === exEntry.id);
  if (i >= 0) actives[i] = exEntry; else actives.push(exEntry);
  conn.sendToc('m_activity_daily_toc', { actives });
}


// 二百八十八：战斗会话跨连接接管。切后台回前台会主动重连（服务端视作新 conn），客户端
// **不会**重发 m_fight_servant_start_tos，只按原节奏继续发 select（真机 2026-11-01 10:52:05
// 实证：10:49:28 后台、10:52:02 重连、10:52:05 首个 select 已落在新连接上）——旧 ownerConn
// 已随连接关闭时一律拒绝，客户端对 err_code=1 只本地推进行动者、永远等不到回合包，战斗场景
// 从此冻结（"切后台回来人物消失卡死"，10:53:57~10:54:40 四连 select 全部无效，只能退出关卡
// 自愈）。D26② 给 mapState.paused 做过同类自愈，这里补战斗会话本体：旧 owner 连接 isClosed
// → 新连接接管（重指 ownerConn 后走各自原有门槛：select 幂等/终局闸门、start 的 batchStarted
// 闸门、cancel 的 inBattleHere 分流）。旧连接仍存活（真双端在线）维持拒绝。
function fightOwnerStale(st) {
  return !!(st && st.ownerConn && st.ownerConn.isClosed);
}

module.exports = { fightOwnerStale,
  handlers: {
// ---- 关卡（出击）----
// 章节地图数据。CopyConfig.getChaptersByType 按 CopyMgr.maxChapter 过滤章节，
// 兜底回包全 0 会让章节列表为空 → CopyMainLineView/CopyEnterPanel 索引 nil 报错。
// 主线第一章节点 ID 为 *100（1010100=1-1 …），材料本为具体 ID（2010101…）。
m_copy_barrier_info_tos(conn, obj) {
  const copy = obj.copy == null ? 1 : obj.copy;
  const chapter = obj.chapter == null ? 0 : obj.chapter;
  // collab 三活动副本（CopyActivityPanel.toBarrierInfo(copyType, chapter)）：不走主线章节表，
  // 屏障表 = 活动关卡清单（CopyMgr.barrierCanEnter 靠它判节点锁定，不下发=全锁）
  const CLB = require('./collab').barrierSetOf(copy);
  if (CLB) {
    conn.sendToc('m_copy_barrier_info_toc', {
      copy, chapter,
      cur_chapter: CLB.cur_chapter,
      barriers: CLB.barriers,
      act_end_time: [],
      max_chapter: CLB.max_chapter,
    });
    log(`[collab] 屏障表 copy=${copy}：${CLB.barriers.length} 关`);
    return;
  }
  // 主线按章回复（客户端 toBarrierInfo 切章带 chapter 重拉，服务端必须回对应章节的关卡，
  // 否则第二章地图上渲染的还是第一章节点）
  conn.sendToc('m_copy_barrier_info_toc', mainBarrierPayload(copy, chapter));
},
// ---- 出击（选择队伍 → 进入冒险小地图）----
// 客户端 CopySortiePanel 点出击只发 m_team_template_init_barrier_tos，之后全靠服务器驱动：
// 1) 回 init_barrier_toc 确认编队（TypeMain 在 COPY_TYPE_MAP 中，客户端会顺带 m_map_pause_tos(0)）
// 2) 主动推 m_map_enter_toc → 客户端 openMapPanel 打开 Unity 小地图
// 地图数据对应 CfgMap_1010100：obj id 即坐标编码 x*1000+y；
// 出生点 type=1 obj 9016(x9,y16)；敌人 type=2：16019/24024/37022（对应 round=3 三场战斗）
m_team_template_init_barrier_tos(conn, obj) {
  conn.psMapClosePending = 0; // 新一次出击：清掉上一关可能遗留的"待收尾"
  conn.psChapterUnlockNext = null; // 同上：解锁事件只在"打赢→close"窗口内有效（二百三十六）
  const barrierId = obj.barrier_id == null ? 1010100 : obj.barrier_id;
  const teamIds = (obj.use_team_ids || []).map(Number);
  const lastId = teamIds[0] || 1;
  const cfg = MAP_CONFIGS[barrierId] || MAP_CONFIGS[1010100];
  const AE = require('./act_extra');
  // 少女终末旅行活动关入场门：周回剩余次数 / 主线解锁链与单次关重打
  const isGlast = !!cfg.actCopy;
  if (isGlast) {
    const ok = cfg.actCopy.type === 'normal'
      ? AE.glastNormalRemain(barrierId) > 0
      : AE.glastMainEntryOk(barrierId);
    if (!ok) {
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      log('[glast] 入场被拒 barrier=' + barrierId + ' type=' + cfg.actCopy.type);
      return;
    }
  }
  // collab 三活动关入场门（单次关已通/高难前置/周回次数/究极试炼次数+芯片）——必须在扣体力**之前**
  if (cfg.collab && !require('./collab').entryOk(conn, barrierId, cfg)) return;
  // EX 挑战关入场门（必须在扣体力之前；客户端不拦次数，拒绝是服务端职责）：
  // 262012=挑战模式在通关主线关卡6-4后开启（CfgErrorCode 实文）；262011=挑战次数已用尽。
  // m_common_tips_toc 走 handleError1 只弹 reason 文案（客户端已缓存提示表）。
  if (cfg.ex) {
    if (require('./story_reward').curChapter() < EX_UNLOCK_CHAPTER) {
      conn.sendToc('m_common_tips_toc', { code: 262012 });
      log(`[ex] 拒绝入场 barrier=${barrierId}：主线进度章 < ${EX_UNLOCK_CHAPTER}`);
      return;
    }
    if (exRemainTimes() <= 0) {
      conn.sendToc('m_common_tips_toc', { code: 262011 });
      pushExDailyUpdate(conn); // 顺带对账（客户端"次数：0/3"可能滞后）
      log(`[ex] 拒绝入场 barrier=${barrierId}：今日次数已用尽 ${S.exState.used}/${EX_COPY_MAX_TIMES}`);
      return;
    }
  }
  // 体力：出击扣「出战誓灵 costVit 之和」（与客户端 CopyPlanPanel 显示的"消耗体力"同口径）；
  // 多队出击（CopySortiePanel maxTeam=2，use_team_ids 数组）按全部出战队伍求和——只扣 lastId
  // 一队会让第二队白进关（二百八十二·续 D）。不足时 spendSortieVit 已回 m_common_error_toc{262006}
  //（客户端弹"体力不足"），这里直接不进图
  if (!require('./vit').spendSortieVit(conn, teamIds)) return;
  // 已通关的关卡重进：重新开启本关探索（times=-1 才可能走到这，单次关已被上面入场门拦下）；
  // 通关记录 g.main 保留（barriers 的 val/type 由它推导），战斗进度清空
  const prog = progressOf(barrierId);
  if (isGlast && cfg.actCopy.type === 'main' && (prog.cleared || []).includes(cfg.bossPoint)) {
    prog.cleared = (prog.cleared || []).filter(id => Math.floor(Number(id) / 10) * 10 !== Number(barrierId));
    saveState();
  }
  const reset = (prog.cleared || []).includes(cfg.bossPoint);
  // 会话重建前的旧会话清位（本条）：S.mapState 在这里**整体覆盖**——若旧会话没走释放路径
  //（重连后直接重新出击/异常路径），旧名册的位 8 会孤儿化（真相源随覆盖消失），玩家被派遣
  // 206001 拒到重启。此处按旧名册就地清位即可：不推 reset_barrier/val:0，新 init 的
  // init_barrier_toc + status=1 马上重建两把锁，同队重叠时 0→1 抖动无害。
  if (S.mapState) {
    const off = [];
    for (const sid of battleRosterOf(S.mapState)) {
      const sb = S.servants.find(x => Number(x.id) === sid);
      if (!sb) continue;
      const cur = Number(sb.status) || 0;
      if ((cur & 8) === 8) { sb.status = cur & ~8; off.push({ servant_id: sb.id, key: CHANGE_ID_STATUS, val: sb.status }); }
    }
    if (off.length) { saveState(); pushServantChanges(conn, off); log(`[map] 旧会话战斗位清理：${off.map(o => o.servant_id).join(',')}（重建 barrier=${barrierId} 前）`); }
  }
  S.mapState = {
    barrierId, lastId, pos: 0, fighting: 0, zone: 0, paused: false,
    defeated: (isGlast || reset) ? [] : (prog.defeated || []).slice(),
    use_team_ids: teamIds, // 记录出战队伍，退出/撤退时据此推 reset_barrier_toc 释放队伍
    collabPaid: cfg.collab ? 1 : 0, // collab 活动关：体力已在上面 spendSortieVit 扣过（enterFight 不重复扣）
  };
  conn.sendToc('m_team_template_init_barrier_toc', {
    barrier_id: barrierId,
    use_team_ids: teamIds,
    last_id: lastId,
  });
  // 编队面板"战斗中"锁（客户端 FormationVO.status，FormationTeamItem.onSelect/isIgnoreClick
  // 弹"该队伍正在战斗中"、onGUI 画 InBattleLine 边框+spFight 角标并禁拖拽）。它与
  // CopyMgr.nowTeamList（init_barrier_toc.use_team_ids，只拦出击选队面板）是两把独立的锁：
  // 只发 init 不发 status 的话，主页按钮出图（会话不释放，见 m_map_pause_tos 注释）后
  // 编队面板毫无标记、可随便改在关卡里的队伍（用户反馈实锤，2026-10-31）。
  // locked 标记是会话级内存（mapState 不落盘）：重连补锁（servant.js info/briefs 尾部）只认它，
  // 避免把 daily/dare/collab 结算后故意残留的 mapState 回填成永久假锁（一百二十五卡死家族）。
  S.mapState.locked = 1;
  const lockIds = [...new Set(teamIds)].filter(id => Number(id) > 0);
  if (lockIds.length) {
    conn.sendToc('m_team_update_status_toc', { updates: lockIds.map(id => ({ id, val: 1 })) });
  }
  // 誓灵级战斗位（status bit3 = 8，客户端 ServantUtil.getIntNBit(x,4)——isBattle"战斗中的誓灵
  // 无法进行编队"/isBattleNow/FormationVO.hasServantInFight 的判定源）。编队锁（status=1 拦队伍
  // 面板编辑）之外的第二道防线：被锁队伍的誓灵在同组其他队的选人面板里被客户端拦下。field+bench
  // 全置（bench 整场待命、随时可能上位）。释放由 pushTeamReset 统一清（二百八十二·续 E）。
  const battleChanges = [];
  const battleRoster = [];
  for (const tid of lockIds) {
    const bf = buildFormation(tid, S.formations[tid]);
    for (const sid of [].concat(bf.field || [], bf.bench || [])) {
      if (!(Number(sid) > 0)) continue;
      if (!battleRoster.includes(Number(sid))) battleRoster.push(Number(sid));
      const sb = S.servants.find(x => x.id === Number(sid));
      if (!sb) continue;
      const cur = Number(sb.status) || 0;
      const ns = cur | 8;
      if (ns !== cur) { sb.status = ns; battleChanges.push({ servant_id: sb.id, key: CHANGE_ID_STATUS, val: ns }); }
    }
  }
  // 登记置位名册（本条）：释放（pushTeamReset）与重建清位都按它对账——会话中途编队换人后
  // "置位名册 ≠ 释放时现算名册"，只按现算清会让被换出者永久带位 8（206001 误拒根源）。
  S.mapState.battleBitIds = battleRoster;
  if (battleChanges.length) { saveState(); pushServantChanges(conn, battleChanges); }
  // 少女终末（lever 面板「选择队伍」→ CopySortiePanel 出击）：**不走小地图**。
  // 该活动 1360 不在 CopyConst.COPY_TYPE_MAP，客户端没有 CfgMap（CfgCopy.mapID="10020" 只是战斗背景层），
  // 推 m_map_enter_toc 会让 AdventureMgr.setMapData 索引 nil 配置冻结；正确后续是
  // m_unmapped_copy_enter_toc（登记"当前活动关"，客户端凭它拦跨关）+ m_copy_fight_prepare_toc
  // （客户端凭它加载战斗场景+布阵面板，与主线"接敌即布阵"同一条链）。
  if (isGlast) {
    const meta = (AE.glastStageOf(barrierId) || {}).meta;
    const fightId = meta ? AE.glastNextFight(meta) : 0;
    if (!fightId) {
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      log('[glast] 无待打战斗点 barrier=' + barrierId);
      return;
    }
    AE.glastPushEnter(conn, barrierId);
    pushFightPrepare(conn, fightId, lastId);
    log('[glast] 入场 barrier=' + barrierId + ' → 布阵战斗点 ' + fightId);
    return;
  }
  // collab 三活动关（约会大作战/究极试炼/星象馆 SideStory3）：与 glasttour 同构——无小地图，
  // init_barrier_toc 后直接推 m_copy_fight_prepare_toc（布阵面板 → m_copy_fight_tos 开战）。
  // 入场门（单次关已通/周回次数/芯片）在 collab.entryOk；体力已在上面 spendSortieVit 扣过。
  if (cfg.collab) {
    pushFightPrepare(conn, barrierId, lastId);
    log('[collab] 入场 barrier=' + barrierId + '（' + cfg.collab.name + '）→ 布阵');
    return;
  }
  pushMapEnter(conn, barrierId, lastId);
},
// 战斗中退出重进：客户端会发 m_map_enter_tos(map_id) 恢复地图；
// fallback 回全 0 会找 CfgMap_0 崩（并卡 UI），这里按记录/请求 id 回有效地图
m_map_enter_tos(conn, obj) {
  // 少女终末活动关无小地图（客户端不会开地图面板，也不该收到 m_map_enter_toc）：
  // 万一收到恢复请求，直接静默忽略，绝不推 CfgMap 不存在的 map_id
  const reqBarrier = (S.mapState && S.mapState.barrierId) || (obj && obj.map_id) || 0;
  if (MAP_CONFIGS[reqBarrier] && MAP_CONFIGS[reqBarrier].actCopy) {
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  // 全清判定必须在重建 mapState 之前：有会话看会话（正在打的这张图），
  // 没会话（服务重启/重连）看存档进度。
  // ⚠️ 这里**不能**直接推 m_map_close_toc：这条 enter 是客户端 onFightBatchEnd 发来的，
  // 紧接着 onShowRewardPanel 就要打开战斗结算面板 / 获得誓灵出卡面板；close 会走
  // openEnterPanel → WindowsManager.open 对栈内所有面板 onInactive → 把结算面板顶掉。
  // 所以只“登记”待收尾，等客户端把结算/出卡播完、quitFightCallback2 发来的
  // m_map_pause_tos(0) 再推（真机 2026-10-22 03:39:02 发 enter，03:39:07 才发 pause(0)）。
  {
    const probeBarrier = (S.mapState && S.mapState.barrierId) || (obj && obj.map_id) || 0;
    const probeCfg = MAP_CONFIGS[probeBarrier];
    if (probeCfg) {
      const liveDefeated = (S.mapState && S.mapState.barrierId === probeBarrier)
        ? S.mapState.defeated
        : progressOf(probeBarrier).defeated;
      if (isMapCleared(probeCfg, liveDefeated)) {
        conn.psMapClosePending = probeBarrier;
        log(`[map] 关卡已全清（${probeBarrier}）→ 照常回图，登记收尾：等结算面板关闭（pause(0)）再推 m_map_close_toc`);
      }
    }
  }
  if (!S.mapState) { // 服务重启后重连：从存档进度恢复
    const barrierId = (obj && obj.map_id) || 1010100;
    const cfg = MAP_CONFIGS[barrierId] || MAP_CONFIGS[1010100];
    S.mapState = {
      barrierId, lastId: 1, pos: cfg.bornPos, fighting: 0, zone: 0, paused: false, // 重启后回出生分量，清空区域会被 relocate 兜底
      defeated: (progressOf(barrierId).defeated || []).slice(),
    };
  }
  // 跨连接残留暂停自愈（二百八十六，2026-10-30 真机 19:52-19:59 实证）：pause(1) 后切后台，
  // 配对的 pause(0) 随连接一起死掉；重连后 mapState 仍在内存里，paused=true 把新连接的
  // move_path（拦截 ack）/move_dst（忽略接敌）全部吞掉，玩家"怪还在却点不动"，重登 4 次不自愈。
  // 只清"带来源戳且来自旧连接"的暂停（同连接战斗结算面板未关闭窗口的正常 pause(1) 不受影响），
  // 并在 enter_toc 之后补推 pause_toc(0)：ON_MAP_RESUME 唤醒客户端地图循环，自动寻敌随之续上
  // （与放弃战斗回图 pause(1)→enter→pause(0) 三连包同一时序，D10 已验证安全）。
  if (S.mapState.paused && S.mapState.pausedBy && S.mapState.pausedBy !== conn) {
    S.mapState.paused = false;
    S.mapState.pausedBy = null;
    conn.psStalePauseHeal = true;
    log(`[map] 进图清除跨连接残留的暂停标记（断线重连自愈）`);
  }
  const barrierId = S.mapState.barrierId || (obj && obj.map_id) || 1010100;
  pushMapEnter(conn, barrierId, S.mapState.lastId || 1);
  if (conn.psStalePauseHeal) {
    conn.psStalePauseHeal = false;
    conn.sendToc('m_map_pause_toc', { op_type: 0 });
  }
},
// 小地图暂停/恢复：客户端在进退战斗、弹窗结算、布阵时控制地图循环与自动寻路。
// op_type: 1=暂停地图（isMapRun=false，禁止移动与自动寻路），0=恢复地图（isMapRun=true，触发 ON_MAP_RESUME 恢复寻路）
// 之前未注册落入 fallback 默认填充回 0，导致战斗胜利结算弹窗尚未关闭地图就被提前唤醒，自动寻敌提前撞击第二只怪，
// 紧接着上一战的结算清理（CLEAR_SCENE）把第二战刚初始化的场景与 isInFightScene 冲掉，导致第二战无法开始。
// ⚠️ 绝不能把 pause(1) 当"地图面板关闭"做会话释放（2026-09-30 一百二十五曾试错）：客户端**接敌进战斗时
// 也会发 pause(1)**——战斗场景打开 → WindowsManager.closeAll() 关地图面板 → AdventureMapPanel.onClose(true)
// → pause(1)，与主页按钮关闭在协议上不可区分；误释放会把战斗中的 mapState 清掉（击败记错 barrier、
// 客户端 m_map_quit_toc 清掉进行中副本标记 → 首杀后怪不消失/玩家回出生点，需二杀）。
// "主页按钮出图不发 quit"的残留改由引导钩子兜底（guide.js releaseWalkthroughTeam，组≥30 上报时释放）。
m_map_pause_tos(conn, obj) {
  const opType = (obj && typeof obj.op_type === 'number') ? obj.op_type : 0;
  // 关卡全清后的收尾时机（二百零九）：客户端 quitFightCallback2 在**结算面板与获得誓灵
  // 出卡面板全部关闭之后**才会发 pause(0)（真机 2026-10-22 03:39:07 实证）。
  // 在这里推 m_map_close_toc，既能保证结算被看到，又能把地图收掉回章节页。
  if (opType === 0 && conn.psMapClosePending) {
    const barrierId = conn.psMapClosePending;
    conn.psMapClosePending = 0;
    if (S.mapState) S.mapState.paused = false;
    conn.sendToc('m_map_pause_toc', { op_type: 0 }); // 先回包（D2：每个 tos 都要有 toc）
    closeClearedMap(conn, barrierId, `关卡已全清（${barrierId}，结算面板已关闭）`);
    return;
  }
  if (S.mapState) {
    S.mapState.paused = (opType === 1);
    // 来源连接戳（二百八十六）：供 m_map_enter_tos 判定"跨连接残留暂停"——
    // pause(1) 后切后台/断线，配对的 pause(0) 永远不会再来，残留会把重连后的
    // move_path/move_dst 全部吞掉（表现为怪点不动、走不动、进不了战斗，重登也不自愈）
    S.mapState.pausedBy = (opType === 1) ? conn : null;
  }
  conn.sendToc('m_map_pause_toc', { op_type: opType });
  log(`[map] 地图暂停状态变更: op=${opType} (${opType === 1 ? '暂停' : '恢复'})`);
},
// 小地图右下角击杀进度：进图时客户端主动请求（AdventureMapPanel.onOpen 发 copy_id=当前关卡）
m_copy_monster_num_tos(conn, obj) {
  const barrierId = (obj && obj.copy_id) || (S.mapState && S.mapState.barrierId) || 1010100;
  pushMonsterNum(conn, barrierId);
},
// 小地图点"退出该关卡"：清战斗/地图状态回主城。 fighting 必须先推 0 解除"战斗中"气泡
// （客户端 AdventureMapPanel.onClickBtnExit 本地关面板但战斗气泡状态在 MapScene，由 fighting_monster_toc(0) 驱动恢复）
m_map_quit_tos(conn, obj) {
  conn.sendToc('m_map_fighting_monster_toc', { monster_id: 0 });
  const mapId = (obj && obj.map_id) || (S.mapState && S.mapState.barrierId) || 1010100;
  releaseMapSession(conn, '退出关卡');
  conn.sendToc('m_map_quit_toc', { map_id: mapId });
  log(`[map] 退出关卡 map=${mapId}`);
},
// 关卡详情面板"撤退"（结束本次探索，再次进入重新开启）：清进度
m_europe_quit_copy_tos(conn) {
  const barrierId = (S.mapState && S.mapState.barrierId) || 1010100;
  conn.sendToc('m_map_fighting_monster_toc', { monster_id: 0 });
  releaseMapSession(conn, '撤退');
  conn.sendToc('m_europe_quit_copy_toc', { barrier_id: barrierId });
  log(`[map] 撤退 barrier=${barrierId}`);
},
// 客户端点击移动发 m_move_path_tos(完整路径格数组，格编码 x*1000+y)。
// 服务器检测路径是否途经怪物节点（CfgMap_1010100 type=2 对象）：
// 有 → 回 m_move_path_toc 把终点截断到碰撞格（小队走过去），记录待触发；
// 小队走到终点会发 m_move_dst_tos → 此时才推 m_map_fighting_monster_toc
// （客户端隐藏小队、敌人头顶冒"战斗中"气泡——原版接敌表现）
m_move_path_tos(conn, obj) {
  const path = (obj && obj.path) || [];
  if (S.mapState && S.mapState.paused) {
    log(`[map] 地图处于暂停状态，拦截移动请求`);
    conn.sendToc('m_move_path_ack_toc', {});
    return;
  }
  if (S.mapState && path.length) {
    S.mapState.justTransferred = false; // 有新的移动请求 → 解除传送后的重复 dst 保护
    const alive = aliveMonsterNodes();
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (alive.has(p)) {
        // 途经存活怪：截断终点。不重置 fighting——战斗场景切换期客户端会重发相同路径，
        // 重置会让胜利时 onBattleWon 找不到击败的怪（雾不散/进度不推进的根因）
        // approachFrom = 踏上怪格前所在格（客户端 toMovePath 把当前格放在 path[0]）：
        // 放弃战斗回小地图时要把玩家退回到这里，否则会站在怪格上——
        // 再点同一只怪时 AStar 路径为空、gotoNode 返回 false，表现为"怪看得见但打不了"。
        S.mapState.approachFrom = i > 0 ? path[i - 1] : (S.mapState.pos || 0);
        S.mapState.pos = p;
        log(`[map] 路径途经事件点 monster=${p}，终点截断待接敌（from=${S.mapState.approachFrom}）`);
        conn.sendToc('m_move_path_toc', { pos: p });
        return;
      }
    }
    // 未途经怪：若上一轮接敌后未开战（玩家取消了布阵），解除战斗气泡恢复小队
    if (S.mapState.fighting) {
      conn.sendToc('m_map_fighting_monster_toc', { monster_id: 0 });
      S.mapState.fighting = 0;
    }
    S.mapState.pos = path[path.length - 1];
  }
  conn.sendToc('m_move_path_ack_toc', {});
},
// 小队走到终点通知（空参）：终点是怪物格 → 触发接敌；终点是传送格 → 跨区域传送
m_move_dst_tos(conn) {
  if (S.mapState && S.mapState.paused) {
    log(`[map] 地图处于暂停状态，忽略接敌通知`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  if (S.mapState && !S.mapState.fighting) {
    const pos = S.mapState.pos || 0;
    if (aliveMonsterNodes().has(pos)) {
      S.mapState.fighting = pos;
      log(`[map] 接敌 monster=${pos}，进入战斗状态`);
      conn.sendToc('m_map_fighting_monster_toc', { monster_id: pos });
      // 原版行为：接敌直接拉起布阵（用户要求"接触上敌人就触发布阵"），
      // 客户端 CopyModule 有被动 handler m_copy_fight_prepare_toc，主动推送即加载战斗场景+布阵面板
      const lastId = S.mapState.lastId || 1;
      conn.sendToc('m_copy_fight_prepare_toc', {
        copy_id: currentFightPoint(),
        team: [buildFormation(lastId, S.formations[lastId])],
        last_id: lastId,
      });
      return;
    }
    // 走到传送格（自动搜寻敌人跨区时客户端就是把传送格当终点走）：推位移
    // 只认"终点"不认途经，避免同区域路径蹭到传送格被莫名传走；
    // justTransferred 防重复 dst 通知把人又传回去（传送落点本身是反向传送格）
    const edge = S.mapState.justTransferred ? null
      : transEdges(mapCfg()).find(e => e.id === pos && e.from === curZone());
    if (edge) {
      S.mapState.pos = edge.val;
      S.mapState.zone = edge.to;
      S.mapState.justTransferred = true;
      saveState();
      conn.sendToc('m_map_transfer_toc', { pos: edge.val });
      pushFindMonster(conn); // ON_FIND_MONSTER_CHANGE → 客户端 checkAutoMove，传送后继续自动寻敌
      log(`[map] 传送 ${edge.id} → ${edge.val}（区域 ${edge.from} → ${edge.to}）`);
      return;
    }
  }
  // 无接敌（走空格）/无地图状态：也要回包，否则 1 秒后弹 NetWaitPanel
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
// 点战斗按钮/自动战斗：客户端 m_copy_fight_prepare_tos(copy_id) → 回编队加载战斗场景
m_copy_fight_prepare_tos(conn, obj) {
  const lastId = (S.mapState && S.mapState.lastId) || 1;
  const AE = require('./act_extra');
  const stage = AE.glastStageOf(Number(obj && obj.copy_id) || 0);
  // 少女终末：lever 面板「开始探索/继续探索」与周回面板「出击」都发本协议（无小地图，直接布阵）。
  // 主线战斗点取**下一个未击败点**（客户端请求的是 now_copy 标记，与真实待打点可能错开一格）
  if (stage) {
    if (stage.meta.type === 'main') {
      const fightId = AE.glastNextFight(stage.meta);
      if (!fightId || !AE.glastMainEntryOk(stage.base)) {
        conn.sendToc('m_common_reply_toc', { proto_id: 0 });
        log('[glast] 布阵被拒 barrier=' + stage.base + ' fight=' + fightId);
        return;
      }
      S.mapState = {
        barrierId: stage.base, lastId, pos: 0, fighting: 0, zone: 0, defeated: [],
        use_team_ids: (S.mapState && S.mapState.use_team_ids) || [lastId],
      };
      AE.glastPushEnter(conn, stage.base); // 刷新"当前活动关"与 lever 进度（重登/服务重启后也能自愈）
      pushFightPrepare(conn, fightId, lastId);
      return;
    }
    if (AE.glastNormalRemain(stage.base) <= 0) { // 周回次数为 0：客户端本地也会拦，这里兜底
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      return;
    }
    S.mapState = { barrierId: stage.base, lastId, pos: 0, fighting: 0, zone: 0, defeated: [], use_team_ids: [lastId] };
    pushFightPrepare(conn, stage.base, lastId);
    return;
  }
  const reqPrepareId = Number(obj && obj.copy_id) || 0;
  if (reqPrepareId >= 1742010100 && reqPrepareId <= 1742013005) {
    const base = Math.floor(reqPrepareId / 100) * 100;
    S.mapState = {
      barrierId: base, lastId, pos: 0, fighting: 0, zone: 0, defeated: [],
      use_team_ids: (S.mapState && S.mapState.use_team_ids) || [lastId],
    };
    pushFightPrepare(conn, reqPrepareId, lastId);
    log(`[act] 天外来客布阵 prepare barrier=${base} fight=${reqPrepareId}`);
    return;
  }
  conn.sendToc('m_copy_fight_prepare_toc', {
    copy_id: currentFightPoint(),
    team: [buildFormation(lastId, S.formations[lastId])],
    last_id: lastId,
  });
},
// 布阵完成点开战：分配 fight_id；客户端收到后自动发 m_fight_servant_start_tos
m_copy_fight_tos(conn, obj) {
  const fightId = S.nextFightId++;
  const reqId = Number(obj && obj.copy_id) || 0;
  const AE = require('./act_extra');
  const stage = AE.glastStageOf(reqId);
  // 少女终末：战斗点 copy_id 命中合成 waves（无小地图，monsterPos 恒 0 不走地图推进）
  if (stage) {
    const batch = Math.max(1, Math.min(10, Number(obj && obj.enemy) || 1)); // 周回连战 N（CopyMgr.enemyBatch）
    if (stage.meta.type === 'normal' && AE.glastNormalRemain(stage.base) < batch) {
      conn.sendToc('m_common_error_toc', { code: 262006 }); // 剩余次数不足
      log('[glast] 周回次数不足 barrier=' + stage.base + ' 需 ' + batch + ' 剩 ' + AE.glastNormalRemain(stage.base));
      return;
    }
    if (!(S.mapState && S.mapState.barrierId === stage.base)) {
      S.mapState = { barrierId: stage.base, lastId: 1, pos: 0, fighting: 0, zone: 0, defeated: [], use_team_ids: [1] };
    }
    S.mapState.fightId = fightId;
    const one = mapCfg().waves[reqId] || [];
    S.fightState = {
      fightId, round: 1, copyId: reqId, teamId: (S.mapState && S.mapState.lastId) || 1, monsterPos: 0,
      glastBatch: batch,
      batches: batch > 1 ? Array.from({ length: batch }, () => one[0] || []) : null,
      ownerConn: conn,
    };
    conn.sendToc('m_copy_fight_toc', { copy_id: reqId, fight_id: fightId });
    log('[glast] 开战 barrier=' + stage.base + ' copy=' + reqId + ' 连战x' + batch);
    return;
  }
  // 天外来客 1742 活动关开战
  if (reqId >= 1742010100 && reqId <= 1742013005) {
    const base = Math.floor(reqId / 100) * 100;
    if (!(S.mapState && S.mapState.barrierId === base)) {
      S.mapState = { barrierId: base, lastId: 1, pos: 0, fighting: 0, zone: 0, defeated: [], use_team_ids: [1] };
    }
    S.mapState.fightId = fightId;
    S.fightState = {
      fightId, round: 1, copyId: reqId, teamId: (S.mapState && S.mapState.lastId) || 1, monsterPos: 0,
      ownerConn: conn,
    };
    conn.sendToc('m_copy_fight_toc', { copy_id: reqId, fight_id: fightId });
    log(`[act] 天外来客开战 barrier=${base} copy=${reqId}`);
    return;
  }
  // 客户端提交的 copy_id 即 prepare 下发的战斗点；兜底按接敌节点推
  const copyId = (obj && obj.copy_id && mapCfg().waves[obj.copy_id])
    ? obj.copy_id
    : currentFightPoint();
  // 挑战关卡 1706（1706001001~1706001007）：战斗复用当前地图点，捕获请求 id 供胜利后记通关
  S.seventhFight = reqId >= 1706001001 && reqId <= 1706001007 ? reqId : 0;
  if (S.mapState) S.mapState.fightId = fightId;
  // monsterPos 开战时定格接敌节点（胜利时据此推进地图进度）
  S.fightState = { fightId, round: 1, copyId, teamId: (S.mapState && S.mapState.lastId) || 1, monsterPos: (S.mapState && S.mapState.fighting) || 0, ownerConn: conn };
  conn.sendToc('m_copy_fight_toc', {
    copy_id: copyId,
    fight_id: fightId,
  });
},
// 玩家放弃战斗（战斗暂停面板「放弃战斗」；**主线 TYPE_MAIN 走的是 ON_FIGHT_CANCEL → 本协议**，
// 不是 m_fight_give_up_tos——见 FightPausePanel.onQuit 的 TYPE_MAIN 分支文案"放弃战斗将回到战斗前的状态"）。
// ⚠️ 2026-10-18（一百八十九）此前**完全没有注册**，落 start.js fallbackHandler 只回
// defaultFill('m_fight_cancel_toc')（fight_id=0）：服务端既不终结战斗会话、也不解除
// mapState.fighting。客户端 m_fight_cancel_toc 只做"退出战斗场景"（onQuitFight + quitFight +
// CLEAR_SCENE），其中的 quitFightOpenPanel(-1) 对主线命中 battleSpecDo → backMainCopy(-1)，
// 而该分支只在 RESULT_WIN 才发 m_map_enter_tos → **什么都不打开**；而地图面板早在进战斗时就被
// WindowsManager.closeAll 销毁 → 玩家看到的就是"直接回到主城"。真机日志 2026-10-18 01:04:39
// 实证：cancel_toc 之后 7 秒才靠主线页 checkAndOpenInfoPanel 自动补发 m_map_enter_tos 救回来。
// 正确语义（= 暂停面板文案"回到战斗前的状态，可重复挑战且不扣除体力"）：
//   退出战斗场景 + 解除接敌气泡，但**保留** mapState（同一关卡继续探索），并主动重推
//   m_map_enter_toc 把玩家放回小地图（战斗前位置、未击败的怪仍在）。

m_fight_cancel_tos(conn, obj) {
  const fightId = (obj && obj.fight_id) || (S.fightState && S.fightState.fightId) || 0;
  const st = S.fightState;
  const ms = S.mapState;
  const cfg = ms ? MAP_CONFIGS[ms.barrierId] : null;
  // 只有真正有小地图的关卡才能重推 m_map_enter_toc：collab/glasttour/fantasy/dare/daily_copy/
  // guide 的合成配置 mapId=0（或无怪链），推过去客户端会去加载不存在的 CfgMap_0 直接崩
  //（2026-09-20 八十二 fallback 回全 0 map_id 的同款事故）。
  const isMapCopy = !!(cfg && Number(cfg.mapId) > 0 && (cfg.monsterChain || []).length);
  // 是否"当前连接正在打这场战斗"：登录后的「当前仍在战斗中，是否进入」弹窗，点左侧"放弃"也会发
  // 本协议（GuideModule 左键 = MainModule.showMain + m_fight_cancel_tos），但那时玩家在主城、
  // 战斗场景根本没打开——不能推 m_map_enter_toc（会把小地图硬盖到主城上）。
  // ownerConn 在 m_copy_fight_tos / start_tos / select_tos 都会写成发起连接；
  // 旧 owner 连接已关闭（切后台重连）时本连接接管，走与正常放弃完全相同的收尾。
  const inBattleHere = !!(st && (st.ownerConn === conn || fightOwnerStale(st)));
  // 塔战/幻梦战有各自独立会话（S.towerFight / S.dreamFight），它们的放弃走同一客户端协议；
  // 此时绝不碰 S.mapState（可能是玩家主线探索到一半的进度）
  const otherSession = !!(S.towerFight || S.dreamFight);
  // 回包先行：客户端 m_fight_cancel_toc 同步退出战斗场景并派发 CLEAR_SCENE；
  // 后续 m_map_enter_toc 必须排在它之后，否则刚建好的地图会被 CLEAR_SCENE 冲掉
  //（一百二十五/八十二"第二战无法开始"的同族时序坑）。
  conn.sendToc('m_fight_cancel_toc', { fight_id: fightId });
  if (otherSession) {
    S.fightState = null; // 塔/幻梦的会话由各自 handler 管，这里只清主线残留
    log(`[fight] 放弃战斗 fight_id=${fightId}（塔/幻梦会话，主线状态未动）`);
    return;
  }
  if (inBattleHere && isMapCopy) {
    if (st) st.over = 1;      // 终局：残留的 select 一律被忽略
    S.fightState = null;      // 战斗会话终结（下一次 m_copy_fight_tos 会重新建）
    // 接敌态必须解除：m_move_dst_tos 有 `!S.mapState.fighting` 守卫，残留会让玩家之后
    // 走到任何怪格都触发不了接敌（表现为"怪还在但点不动/打不了"）
    ms.fighting = 0;
    ms.paused = false;        // 进战斗时客户端发过 pause(1)，地图重开后要能移动
    ms.fightId = 0;
    // 退回接敌前那格：原地留在怪格上时客户端 gotoNode 算不出路径（起终点同格 →
    // AStar 空数组 → 返回 false），点同一只怪会毫无反应。没有记录就留在原地（旧行为）。
    if (ms.approachFrom) { ms.pos = ms.approachFrom; ms.approachFrom = 0; }
    // 不写盘：mapState 本来就不进存档（state.js saveState 的 payload 无该字段），
    // 而真机单次 fsync 500~950ms 会把 cancel_toc 与 map_enter_toc 拉开（一百六十七的同族坑）。
    // 解除敌人头顶"战斗中"气泡（客户端 MapScene.updateMyRoleState），再重开小地图。
    // ★ pause(1)→enter→pause(0) 三连包（2026-10-18 复盘修正，一百九十）：
    //   客户端 onMapEnterToc 的"从战斗进入"分支（跳过 isInAutoMove 写回）靠文件级 uv0 判定，
    //   而该 uv0 由 **m_map_pause_toc 的回包**写入（bc 反汇编：onMapEnterToc proto99 与
    //   m_map_pause_toc proto63 捕获的是 main 块同一个 slot0——此前"不是同一变量"的结论是
    //   错的，当年探针对 pause_toc 的包装同样踩了指南 A3 死钩子，一条都没打出来）。
    //   真机 12:47/12:57 会话实证回图后 auto=false→true：客户端 quitFightCallback2 在
    //   cancel_toc 之后自己发 m_map_pause_tos(0)，其回包 pause_toc(0) 恰好插在本服务的
    //   enter_toc 之前把 uv0 清 0。TCP 有序性保证：客户端的 pause(0) 只能在收到 cancel_toc
    //   后发出，因此**本连接**的这三包必然排在客户端 pause(0) 的回包之前——竞态从根上消除：
    //     pause_toc(1)  → uv0=1（"从战斗进入"，且 AdventureMgr.pause 冻结地图循环）
    //     enter_toc     → onMapEnterToc 命中 uv0 分支，跳过 getCopyAutoState 写回（auto 保持 false）
    //     pause_toc(0)  → uv0=0 + AdventureMgr.resume + ON_MAP_RESUME（地图恢复运行）
    conn.sendToc('m_map_fighting_monster_toc', { monster_id: 0 });
    conn.sendToc('m_map_pause_toc', { op_type: 1 });
    // skipFindMonster：回图后不重推 find_monster（见 pushMapEnter 内注释——find_monster_toc
    // → ON_FIND_MONSTER_CHANGE → checkAutoMove 是与 uv0 无关的另一条自动寻敌触发链，正是
    // "放弃后又扑向下一只怪"的直接推手）。玩家想再自动寻敌点一次"搜寻敌人"即可
    //（onClickBtnAuto → checkAutoMove → getFirstFindNode 兜底仍能寻到怪）；
    // 只跳过"放弃后"这一次，入图/胜利/传送路径的 find_monster 不受影响。
    pushMapEnter(conn, ms.barrierId, ms.lastId || 1, { skipFindMonster: true });
    conn.sendToc('m_map_pause_toc', { op_type: 0 });
    // 暂停面板的"取消搜寻/搜寻敌人"开关**不落档**（AdventureMgr.slot1 表仅内存态），
    // 且 m_map_pause_toc(0) 恢复时 isMapRun 已为 true——无需也无法在服务端持久化该开关。
    log(`[fight] 放弃战斗 fight_id=${fightId} map=${ms.barrierId} pos=${ms.pos}（会话终结 + pause/enter/pause 三连回小地图）`);
    return;
  }
  // 其余口径：登录续战提示的"放弃"、无会话的迟到包、合成关卡（活动/幻梦/塔/教学）
  S.fightState = null;
  if (isMapCopy) {
    // 主线小地图：保留 pos/defeated（玩家回主城后从副本页重进，m_map_enter_tos 走正常链路），
    // 只清接敌/战斗标记；不能 releaseMapSession，否则重进会掉回出生点
    if (ms) { ms.fighting = 0; ms.fightId = 0; }
    log(`[fight] 放弃战斗 fight_id=${fightId}（非本连接实战，保留地图进度 map=${ms.barrierId}）`);
    return;
  }
  if (ms) releaseMapSession(conn, `放弃战斗(无小地图) fight_id=${fightId}`);
  log(`[fight] 放弃战斗 fight_id=${fightId}（无小地图关卡/无会话，仅清会话）`);
},
// 玩家主动放弃战斗（战斗暂停面板「放弃战斗」→ m_fight_give_up_tos）。
// ⚠️ 2026-10-13（一百七十四）此前**完全没有注册**，走 start.js fallbackHandler 回
// defaultFill('m_fight_give_up_toc')：客户端 m_fight_give_up_toc 立刻 hideWindowLayer +
// quitFightOpenPanel(RESULT_LOSE) + onShowRewardPanel() → CopyRewardPanel → RoleBuffView
// （isShort=true）onGUI 读 CopyMgr.getResult(fightId)，而结算包从未下发 → resultVO 为 nil
// → checkActive 索引 resultVO.showRewards 崩「attempt to index field 'resultVO'」。
// 官方语义放弃=战败：补丁发 LOSE 结算包（零奖励）+ scene_result=LOSE，与 alliesAllDead
// 战败分支同口径；同时终局标记 over=1 并释放出战队伍，杜绝对话残留（同 guide 兜底同族事故）。
m_fight_give_up_tos(conn, obj) {
  const fightId = (obj && obj.fight_id) || (S.fightState && S.fightState.fightId) || 0;
  const st = S.fightState;
  // 回包先行：客户端 m_fight_give_up_toc 负责关面板/开结算，不依赖服务端是否还有会话
  conn.sendToc('m_fight_give_up_toc', { fight_id: fightId });
  if (!st || Number(st.fightId) !== Number(fightId)) {
    log(`[fight] 放弃战斗 fight_id=${fightId}（无进行中会话，仅回包）current=${st ? st.fightId : 0}`);
    // 无会话也要补结算包：客户端仍会开结算面板（onShowRewardPanel 无条件执行）
    conn.sendToc('m_fight_result_toc', {
      fight_id: fightId || 1,
      copy_id: (S.mapState && S.mapState.barrierId) || currentFightPoint(),
      result: 0, mvp: 0, star: [], gold: 0, silver: 0, role_exp: 0,
      servant_reward: [], item_reward: [], servant_exp: [],
      kill_num: 0, mvp_stats: [], score: 0, add_score: 0, replace_list: [],
    });
    conn.sendToc('m_fight_scene_result_toc', { fight_id: fightId || 1, result: 0 });
    return;
  }
  st.over = 1; // 终局：后续 m_fight_skill_select_tos 一律忽略
  const copyId = st.copyId || currentFightPoint();
  conn.sendToc('m_fight_result_toc', {
    fight_id: fightId,
    copy_id: copyId,
    result: 0, // FightConst.RESULT_LOSE
    mvp: 0,
    star: [], gold: 0, silver: 0, role_exp: 0,
    servant_reward: [], item_reward: [], servant_exp: [],
    kill_num: (st.enemies || []).filter(e => e.hp <= 0).length,
    // 放弃=战败语义：有会话就带统计（打了几回合的输出/承伤可回看）；开战即弃则全 0 行
    mvp_stats: FS.buildRows(st.mvpStats, st.allies, S.servants), score: 0, add_score: 0, replace_list: [],
  });
  conn.sendToc('m_fight_scene_result_toc', { fight_id: fightId, result: 0 });
  releaseMapSession(conn, `放弃战斗 fight_id=${fightId}`);
  log(`[fight] 放弃战斗 fight_id=${fightId} copy=${copyId}（LOSE 结算包已发，出战队伍已释放）`);
},
// 战斗开始：side=0 我方在左；多波 BOSS 战 batch_num>1。
// 每波结束客户端 toNextBatchAnimation（转场镜头右移）→ 重发 m_fight_servant_start_tos，
// 服务端按当前 batch 推该波进场（round_start=1 + 新 enter_list）
m_fight_servant_start_tos(conn, obj) {
  const fightId = (obj && obj.fight_id) || (S.mapState && S.mapState.fightId) || 1;
  if (!S.fightState || Number(S.fightState.fightId) !== Number(fightId)) {
    // 允许 mapState 已登记但进程重连后的恢复启动；不能接受完全陌生的 ID。
    if (S.fightState || !S.mapState || Number(S.mapState.fightId) !== Number(fightId)) {
      log(`[fight] 拒绝无效 start fight_id=${fightId} current=${S.fightState ? S.fightState.fightId : (S.mapState && S.mapState.fightId) || 0}`);
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      return;
    }
    S.fightState = { fightId, round: 1, copyId: currentFightPoint(), teamId: S.mapState.lastId || 1, batch: 1 };
  }
  if (S.fightState.ownerConn && S.fightState.ownerConn !== conn) {
    if (!fightOwnerStale(S.fightState)) {
      log(`[fight] 拒绝跨连接 start fight_id=${fightId}`);
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
      return;
    }
    log(`[fight] 跨连接 start 接管 fight_id=${fightId}（旧 owner 连接已关闭）`);
  }
  S.fightState.ownerConn = conn;
  const batches = fightBatches(S.fightState);
  const batchNum = batches.length || 1;
  const batch = Math.min(S.fightState.batch || 1, batchNum);
  // 幂等闸门（二百八十六，2026-10-30 真机 19:49:56 实证）：该波已开战后，重复 start 一律拒绝——
  // 自动寻敌"到点自动开战"与布阵面板「出击」会在 ~10ms 内各发一次 start（真机两连发中间还夹一条
  // move_path），此前两次都全量执行：按新 wire id 把整场战斗重建一遍（敌人 2100-2102 → 2103-2105、
  // 我方 100/101 → 102/103），客户端场景被二次初始化，上一份包的演出队列变成孤儿——波转场的
  // 死亡处理帧里冒出别处排队的回血飘字，玩家看到的就是"尸体能力上升"。
  // 合法 start 只有两种：本会话首次开战（enemies 未建）、波次推进后（batch 已 +1）；
  // 终局（over=1）后的迟到 start 同样拒绝（重试链走 copy_fight 换新 fight_id，不经这里）。
  if (Array.isArray(S.fightState.enemies) && S.fightState.enemies.length
      && (S.fightState.over || batch <= Number(S.fightState.batchStarted || 0))) {
    log(`[fight] 忽略重复 start fight_id=${fightId} batch=${batch}（该波已开战 batchStarted=${S.fightState.batchStarted || 0}${S.fightState.over ? '，已终局' : ''}，竞态去重）`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  S.fightState.batchStarted = batch;
  S.fightState.batch = batch;
  S.fightState.round = 1; // 新波次回合重置
  S.fightState.over = 0;  // 转场续战开启新波（上一波的全灭标记清掉）
  substituteBench(S.fightState); // 波转场：上一波阵亡的主力由替补顶替（enter 随新波首包下发）
  conn.sendToc('m_fight_servant_start_toc', {
    fight_id: fightId,
    side: 0,
    batch,
    batch_num: batchNum,
  });
  pushFightRound(conn, fightId, 1, null, batch);
},
// 玩家每回合选完技能：按速度序结算双方行动 → 回确认 + 推动作回合。
// select_list 为 p_kvt{id:誓灵id, val:技能id, type:目标格brief_pos}——val=0（自动战斗）时
// 服务端按 findBestSkill 镜像决策（治疗优先 → 最大总威力），敌方行动同规则；
// 技能次数（power_point）逐次扣减并经 update 数组回推（客户端 dealUpdateData type=1 刷新技能栏）
m_fight_skill_select_tos(conn, obj) {
  const fightId = (obj && obj.fight_id) || (S.fightState && S.fightState.fightId) || 1;
  const st = S.fightState;
  if (!st || Number(st.fightId) !== Number(fightId) || !st.enemies || !st.allies) {
    log(`[fight] 拒绝无效 select fight_id=${fightId} current=${st ? st.fightId : 0}`);
    conn.sendToc('m_fight_skill_select_toc', { err_code: 1 });
    return;
  }
  if (st.ownerConn && st.ownerConn !== conn) {
    if (!fightOwnerStale(st)) {
      log(`[fight] 拒绝跨连接 select fight_id=${fightId}`);
      conn.sendToc('m_fight_skill_select_toc', { err_code: 1 });
      return;
    }
    log(`[fight] 跨连接 select 接管 fight_id=${fightId}（旧 owner 连接已关闭，切后台重连续战）`);
  }
  st.ownerConn = conn;
  conn.sendToc('m_fight_skill_select_toc', { err_code: 0 });
  // 战斗已结束（战败/敌方全灭等终局）——重复 select 忽略：
  // 否则战败后会继续空转、超回合兜底还会误判胜并二次掉落
  if (st.over) {
    log(`[fight] 忽略重复 select（战斗已结束 over=${st.over}）`);
    return;
  }
  if (st.enemies.length && st.enemies.every(e => e.hp <= 0)) {
    st.over = 2; // 敌方已全灭：上一回合已结束本波（客户端应转场 start_tos 或已收结算）
    log(`[fight] 忽略重复 select（波${st.batch || 1} 敌方已全灭）`);
    return;
  }
  st.round++;
  substituteBench(st); // 替补上位：上一回合阵亡的主力由备战位顶替（enter 随本回合包下发；当回合不行动不被指向，2026-11-01 工单，二百八十二·续 G 修正）
  const stateCheck = FC.validateBattleState(st, (st.allies || []).concat(st.enemies || []));
  if (!stateCheck.ok) log(`[fight] 回合状态已规整 round=${st.round} repairs=${stateCheck.repairs}`);
  if (st.round > FIGHT_MAX_ROUND) { // 超回合判负，不能清空敌方伪造胜利
    pushFightRound(conn, fightId, st.round, []);
    st.over = 1;
    conn.sendToc('m_fight_result_toc', {
      fight_id: fightId, copy_id: st.copyId || currentFightPoint(), result: 0,
      mvp: 0, star: [], gold: 0, silver: 0, role_exp: 0,
      servant_reward: [], item_reward: [], servant_exp: [],
      kill_num: (st.enemies || []).length,
      // 超回合判负也带统计：战败详情页同样亮详情按钮（CopyRewardPanel 败样式已适配）
      mvp_stats: FS.buildRows(st.mvpStats, st.allies, S.servants), score: 0, add_score: 0, replace_list: [],
    });
    conn.sendToc('m_fight_scene_result_toc', { fight_id: fightId, result: 0 });
    return;
  }
  // 手动选择：val>0 = 技能id，type = 目标格 brief_pos（ FightModule.toSelSkill 同源编码）
  // select_list[].id 是客户端回传的战斗 id（bid）→ 反查回引擎单位（一百八十八 方案 A'）
  // targeting pool：排除"本回合登场"的替补（enteringRound）——客户端 born 在回放结束后才执行，
  // 本回合内该单位不在场景，任何动作指向它都会让 CheckAct/CheckHide/CheckHurt 每帧 nil 崩
  // （2026-11-01 真机工单：敌方 AI 选中了刚登场的替补 → 972 条 FightLoop 报错刷屏）。
  // 败判定/结算仍走 st.allies 全量（替补在场即算存活）。
  const enteringIds = new Set((st.allies || []).filter(u => u && u.enteringRound === st.round).map(u => u.id));
  const units = st.allies.concat(st.enemies).filter(u => !(u && enteringIds.has(u.id)));
  // MVP 统计（调研-结算详情页.md §4）：回合起点 HP 快照 + 本回合 results 留档。
  // settleRoundDiff 用差分兜底所有绕过 results 的 HP 突变（回合末 tick/受创反应/进场天赋）。
  if (!st.mvpStats) st.mvpStats = FS.newStats();
  const mvpHpBegin = {};
  units.forEach(u => { if (u) mvpHpBegin[u.id] = u.hp; });
  const mvpRoundLog = [];
  const selMap = {};
  ((obj && obj.select_list) || []).forEach(s => {
    const u = s && s.id ? units.find(x => bidOfUnit(x) === Number(s.id) || x.id === Number(s.id)) : null;
    if (u && Number(s.val) > 0) selMap[u.id] = { skillId: Number(s.val), targetPos: Number(s.type) || 0 };
  });
  // 攻击意图（10331 警觉射击 / 21840 超常感知消费）：回合开始对每个存活敌方预演 AI 主目标。
  // aiChoose 无随机 ⇒ 同一状态必同结果；必须先于 sortActors 构建（超常感知的优先度+1 在排序里读 st.selMap）。
  st.selMap = {};
  (st.enemies || []).filter(e => e && e.hp > 0).forEach(e => {
    const ch = FC.aiChoose(e, units);
    if (ch && ch.main) st.selMap[e.id] = ch.main.id;
  });
  units.forEach(u => { if (u && u.eternalReleaseAtRound && Number(st.round) >= Number(u.eternalReleaseAtRound)) u.eternalReleased = true; });
  FC.applySkillPriorities(units, st, selMap); // 批次E：官方技能优先度进排序（chosenSkillPrio/Nature 此前无人写）
  const actors = FC.sortActors(units, st, selMap); // 速度降序（考虑 speed_lv 与麻痹；玩家选技供乱流风系优先度）；行动中阵亡者跳过
  actors.forEach(a => { if (a && a.skillLockRound && a.skillLockRound < st.round) { a.skillLock = null; a.skillLockRound = 0; } });
  const fightList = [];
  const updates = [];
  const roundEffects = [];
  let actIndex = 0;
  let elementRefired = false;
  // 意图复算：延时攻击/元素唤醒/每个动作都会改变战场；已行动敌方定格为其实际主目标，
  // 未行动敌方按当前战场复算（"意图被改变"——嘲讽/吸引改写目标后意图同步跟随）。
  const refreshIntents = (fromIdx, lockActor, lockAim) => {
    (st.enemies || []).forEach(e => { if (!e || e.hp <= 0) delete st.selMap[e.id]; });
    for (let k = fromIdx; k < actors.length; k++) {
      const nx = actors[k];
      if (!nx || nx.side === 0) continue;
      if (lockActor && nx === lockActor) { if (lockAim != null) st.selMap[nx.id] = lockAim; continue; }
      if (nx.hp <= 0) { delete st.selMap[nx.id]; continue; }
      const ch = FC.aiChoose(nx, units);
      if (ch && ch.main) st.selMap[nx.id] = ch.main.id; else delete st.selMap[nx.id];
    }
  };
  // 10304 摩竭之噬：上一回合种下的延时攻击，本回合自动结算（不占技能选择）
  [].concat(st.allies || [], st.enemies || []).forEach(u => {
    if (!u || u.hp <= 0 || !u.delayedStrike || st.round < u.delayedStrike.round) return;
    const ds = u.delayedStrike; u.delayedStrike = null;
    const foeSide = u.side === 0 ? 1 : 0;
    let tgt = units.find(x => x && x.id === ds.targetId && x.hp > 0);
    if (!tgt) {
      const foeList = units.filter(x => x && x.hp > 0 && x.side === foeSide);
      tgt = foeList[Math.floor(Math.random() * foeList.length)];
    }
    if (!tgt) return;
    const base = FC.skillCfg(ds.skillId || 10304);
    if (!base) return;
    const dcfg = Object.assign({}, base, { power: (Number(base.power) || 0) * (ds.power || 1) });
    const de = FC.settleSkill(u, dcfg, [tgt], units, null, actIndex, st);
    if (de.wakeEffects && de.wakeEffects.length) roundEffects.push(...FC.flattenEffects(de.wakeEffects)); // 三百·续：旁路出口须过 flatten
    const dse = FC.applySkillEffects(u, dcfg, [tgt], units, actIndex, st);
    if (dse.length) roundEffects.push(...dse);
    fightList.push({
      atk_id: bidOfUnit(u), skill_id: dcfg.id, index: actIndex, power_point: 0,
      effect_list: de.map(e => ({
        type: 0, target: bidOfUnit(units.find(x => x.id === e.target) || { bid: e.target }),
        hurt: e.hurt, final_hp: e.final_hp,
        shield_hurt: Number(e.shield_hurt) || 0, final_shield: Number(e.final_shield) || 0,
        element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
      })),
      result: 0,
    });
    actIndex++;
    log(`[element] 10304 延时攻击结算 sid=${u.id} → ${tgt.id} power=${dcfg.power}`);
  }); // 专属改写"每回合只能触发一次"（本回合内是否已连发）
  // ---- 元素唤醒（装备了元素精灵的我方誓灵，一场只能发动一只，持续 3 回合）----
  // 顺序固定：先推进既有状态（3→2→1→0），再处理本回合的发动申请 —— 发动那一回合不能被自己减掉。
  tickElementStates(st, roundEffects);
  if (Number(obj && obj.element_id) > 0) {
    activateElement(st, units, Number(obj.element_id), roundEffects);
  }
  const startTalents = FC.settleRoundStartTalents(units, st.round, actIndex, st);
  if (startTalents.length) roundEffects.push(...startTalents);
  const aliveEnemies = () => st.enemies.filter(e => e.hp > 0);
  const aliveAllies = () => st.allies.filter(a => a.hp > 0);
  // 场景可见的我方（＝aliveAllies − 本回合登场的替补）：只用于"选目标"（手动治疗回落/天击封锁回落），
  // 败判定/结算必须继续用 aliveAllies 全量（登场替补在场即算存活）。
  const sceneAllies = () => aliveAllies().filter(a => !enteringIds.has(a.id));
  // 意图全量复算（延时攻击/元素唤醒可能已改变战场）+ 21840 超常感知 tips 展示（优先度加成已在 sortActors 结算）
  refreshIntents(0);
  units.filter(u => u && u.hp > 0 && u.talent === 21840
    && Object.values(st.selMap).some(tid => Number(tid) === Number(u.id)))
    .forEach(u => roundEffects.push({ // 运行时特性 218401 带 tips「初濑伊纲察觉了敌方的攻击意图！」
      trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
      src_type: 1, src_id: 21840, id: 218401, effect_phase: 0,
      change_type: 200000, change_value: [0], remove_round: 0,
    }));
  // 青龙（23270 苍之疾走）：第 2 回合以独立行动补播入场技能（首包 round_start=1 不播 fight_list）
  if (Number(st.round) >= 2) {
    units.filter(u => u && u.hp > 0 && u.qinglongPending).forEach(u => {
      u.qinglongPending = false;
      const hasBaihu = units.some(b => b && b.hp > 0 && b.side === u.side && b.talent === 23300);
      const pick = hasBaihu ? u.skills[u.skills.length - 1] : u.skills[Math.floor(Math.random() * u.skills.length)];
      const qcfg = FC.skillCfg(pick && (pick.id || pick));
      if (!qcfg) return;
      const friend = FC.isFriendEff(qcfg.effType);
      const pool = units.filter(x => x && x.hp > 0 && x.side === (friend ? u.side : (u.side === 0 ? 1 : 0)));
      if (!pool.length) return;
      const main = pool[Math.floor(Math.random() * pool.length)];
      let qTargets = FC.targetsOfEff(qcfg.effType, u.side, units, main, u, qcfg.id);
      if (!qTargets.length) qTargets = friend ? [u] : [main];
      const qres = FC.settleSkill(u, qcfg, qTargets, units, null, actIndex, st) || [];
      const qeff = FC.applySkillEffects(u, qcfg, qTargets, units, actIndex, st) || [];
      const qtal = FC.checkTalentsAfterSkill(u, qcfg, qTargets, qres, units, actIndex, st) || [];
      fightList.push({
        atk_id: bidOfUnit(u), skill_id: qcfg.id, index: actIndex,
        power_point: ((u.skills || []).find(x => Number(x.id) === Number(qcfg.id)) || {}).pp || 0,
        effect_list: qres.map(e => ({
          type: 0, target: bidOfUnit(units.find(x => x.id === e.target) || { bid: e.target }),
          hurt: e.hurt, final_hp: e.final_hp,
          shield_hurt: Number(e.shield_hurt) || 0, final_shield: Number(e.final_shield) || 0,
          element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
        })),
        result: 0,
      });
      if (qres.wakeEffects && qres.wakeEffects.length) roundEffects.push(...FC.flattenEffects(qres.wakeEffects));
      if (qeff.length) roundEffects.push(...qeff);
      if (qtal.length) roundEffects.push(...qtal);
      actIndex++;
      log(`[fight] 青龙天赋补播：${u.id} 释放 ${qcfg.id}（第${st.round}回合）`);
    });
  }

  for (let ai = 0; ai < actors.length; ai++) {
    const actor = actors[ai];
    if (actor.hp <= 0) continue;
    if (aliveEnemies().length === 0) break; // 敌全灭，剩余行动不结算（客户端播完转场）
    // 10432 羁绊连环：成功后自身跳过下次行动
    if (actor.skipNextAction) {
      actor.skipNextAction = false;
      fightList.push({ atk_id: bidOfUnit(actor), skill_id: 10081, index: actIndex, power_point: 99, effect_list: [], result: 1 });
      actIndex++;
      continue;
    }

    // 行动前异常状态判定（睡眠/冻结/麻痹/混乱/灵魂画手 20% 失手）
    const actCheck = FC.checkUnitCanAct(actor, units, actIndex);
    // 成功路径也可能带效果（灵魂画手"成功行动则自损 3 项能力"的 100000 变化）——无条件并入
    if (actCheck.effects && actCheck.effects.length) {
      roundEffects.push(...actCheck.effects);
    }
    if (!actCheck.canAct) {
      const wAtk = bidOfUnit(actor); // wire id（下发给客户端用）
      if (actCheck.selfHit) {
        FS.accumulateSelfHit(st.mvpStats, actor, actCheck.selfDmg); // 混乱自伤计入承伤
        fightList.push({
          atk_id: wAtk,
          skill_id: 10081,
          index: actIndex,
          power_point: 99,
          effect_list: [{
            type: 0, target: wAtk, hurt: actCheck.selfDmg,
            final_hp: actCheck.finalHp,
            shield_hurt: 0, final_shield: Math.max(0, actor.shield || 0),
            element_shield_hurt: 0, final_element_shield: 0, extra: 0,
          }],
          result: 0,
        });
        actIndex++;
      } else {
        fightList.push({
          atk_id: wAtk,
          skill_id: 10081,
          index: actIndex,
          power_point: 99,
          effect_list: [],
          result: 1, // SKILL_RESULT_FAIL
        });
        actIndex++;
      }
      continue;
    }

    // 决策：我方尊重手动选择（技能在池中且有余次），否则按作战策略（自动 val=0 时策略介入）；
    // 敌方全 AI（最优策略 aiChoose 原行为，作战策略不作用于敌方）
    let choice = null;
    const manual = actor.side === 0 ? selMap[actor.id] : null;
    if (manual) {
      let sk = (actor.skills || []).find(s => s.id === manual.skillId && s.pp > 0);
      // P3-B 禁辅（鏖战入狂/激昂战意等）：禁辅期间辅助技不可选（客户端不拦，服务端兜底）
      if (sk && (actor.supportBanRounds || 0) > 0) {
        const sc = FC.skillCfg(sk.id);
        if (sc && (((sc.healPct && !(sc.power > 0)) || FC.isFriendEff(sc.effType)))) {
          log(`[fight] 禁辅生效：${actor.id} 无法使用辅助技 ${sk.id}`);
          sk = null;
        }
      }
      if (sk) {
        const cfg = FC.skillCfg(manual.skillId);
        const friendEff = !!(cfg && FC.isFriendEff(cfg.effType));
        // 手动目标格 → 反解坐标（FightModule.onSureSelTar 的 brief_pos）。
        // ⚠️ 2026-11-08 修复：旧实现**只在 aliveEnemies() 里找**，任何单体辅助/治疗技
        //    选己方目标必然落空 → 回落"血量比例最低队友"→ 玩家看到"选了 A 却加到 B 身上"。
        //    targetPos 是客户端点选单位所在格，与技能阵营无关；按技能目标阵营选池。
        let main = null;
        if (manual.targetPos) {
          main = FC.resolveTargetPos(friendEff ? sceneAllies() : aliveEnemies(), manual.targetPos);
        }
        // 自身类（effType 2001，如战吼/疾风的祝福/自我修复）：目标就是施术者本身。
        // 旧实现在无 targetPos 时也回落最低血队友，会把自身增益加到别人身上。
        if (cfg && Number(cfg.effType) === 2001) main = actor;
        if (!main && cfg && (cfg.healPct && !(cfg.power > 0) || friendEff)) { // 手动治疗/增益无有效目标 → 血量比例最低队友（复合攻击技如天之甘露仍默认打敌人）
          let ratio = 2;
          sceneAllies().forEach(f => { const r = f.hp / f.maxHp; if (r < ratio) { ratio = r; main = f; } });
        }
        if (!main) main = friendEff ? actor : aliveEnemies()[0];
        choice = { skillId: manual.skillId, main };
      }
    }
    // 决策统一走 autoChoose（三百零三）：PS_AI_SEARCH=0 走贪心 B1（原行为）；1/2 走期望树搜索。
    // 作战策略模式（自行/单体/群体）在 autoChoose 内部优先于搜索。⚠️ 上方意图复算（2048/2068）
    // 保持 aiChoose depth0——搜索化会 430ms/回合（调研-自动战斗AI与魔法箭.md §四 B2 性能预算）。
    if (!choice) choice = FC.autoChoose(actor, units, { allyCtx: SC.aiCtxOf(), battleState: st });
    // 10150 圣光之矢：目标下回合无法使用本回合用过的技能 → 锁定命中后换一个可用技能
    if (choice && actor.skillLock && actor.skillLockRound === st.round && actor.skillLock.includes(choice.skillId)) {
      const alt = (actor.skills || []).find(s => s.pp > 0 && !actor.skillLock.includes(s.id));
      log(`[element] 10150 技能锁：sid=${actor.id} 跳过 ${choice.skillId}${alt ? ` → ${alt.id}` : '（无可用替代）'}`);
      if (alt) choice = { skillId: alt.id, main: choice.main };
    }
    // 10003 心灵暗示（批次H3）：接下来 3 次只能使用"最后使用的技能"——手动选择被强制改写
    if (choice && (actor.mindShackleCount || 0) > 0 && actor.mindShackleSkillId != null
        && Number(choice.skillId) !== Number(actor.mindShackleSkillId)) {
      const locked = (actor.skills || []).find(s => Number(s.id) === Number(actor.mindShackleSkillId) && s.pp > 0);
      if (locked) {
        log(`[fight] 心灵暗示生效：sid=${actor.id} 强制改用 ${locked.id}（原选择 ${choice.skillId}）`);
        choice = { skillId: locked.id, main: choice.main };
      }
    }
    // 10261 天击（批次H3）：下一回合无法使用攻击技能 → 强制改选辅助/治疗技（无则维持原选择）
    if (choice && (actor.noAttackRounds || 0) > 0) {
      const cc = FC.skillCfg(choice.skillId);
      if (cc && (Number(cc.type) === 1 || Number(cc.type) === 2) && Number(cc.power) > 0) {
        const sup = (actor.skills || []).find(s => s.pp > 0 && (() => {
          const x = FC.skillCfg(s.id);
          return x && !((Number(x.type) === 1 || Number(x.type) === 2) && Number(x.power) > 0);
        })());
        if (sup) {
          const supCfg = FC.skillCfg(sup.id);
          let supMain = choice.main;
          if (FC.isFriendEff(supCfg.effType)) { // 辅助技目标回落最低血量比例队友
            let ratio = 2; supMain = null;
            sceneAllies().forEach(f => { const r = f.hp / f.maxHp; if (r < ratio) { ratio = r; supMain = f; } });
            supMain = supMain || actor;
          }
          log(`[fight] 天击封锁：sid=${actor.id} 攻击技 ${choice.skillId} → 辅助技 ${sup.id}`);
          choice = { skillId: sup.id, main: supMain };
        }
      }
    }
    // 10323 永恒解脱：解脱状态只能使用辅助技能
    if (choice && actor.eternalReleased) {
      const c0 = FC.skillCfg(choice.skillId);
      if (c0 && (c0.type === 1 || c0.type === 2) && Number(c0.power) > 0) {
        const sup = (actor.skills || []).find(s => s.pp > 0 && (() => {
          const x = FC.skillCfg(s.id);
          return x && !((x.type === 1 || x.type === 2) && Number(x.power) > 0);
        })());
        if (sup) {
          const sc = FC.skillCfg(sup.id);
          let supMain = choice.main;
          if (FC.isFriendEff(sc.effType)) {
            let ratio = 2; supMain = actor;
            sceneAllies().forEach(f => { const r = f.hp / f.maxHp; if (r < ratio) { ratio = r; supMain = f; } });
          }
          log(`[fight] 解脱状态：${actor.id} 强制改用辅助技 ${sup.id}`);
          choice = { skillId: sup.id, main: supMain };
        } else {
          choice = null;
        }
      }
    }
    if (!choice) {
      if (actor.eternalReleased) log(`[fight] 10323 解脱状态且无可用辅助技：${actor.id} 跳过行动`);
      continue;
    }
    const cfg = FC.skillCfg(choice.skillId);
    if (!cfg) continue;
    // 10372 反核弹外壳：连续两回合使用 → 50% 失败（不结算、不产生行动）
    if (cfg.id === 10372 && actor.nukeLastRound === st.round - 1 && Math.random() < 0.5) {
      log(`[element] 10372 反核弹外壳连续使用失败 sid=${actor.id}`);
      continue;
    }
    // 记录本回合用过的技能（供 10150 的"下回合禁用"复制）
    if (!actor.usedSkillsRound || actor.usedSkillsRound !== st.round) { actor.usedSkillsRound = st.round; actor.usedSkillsThisRound = []; }
    if (!actor.usedSkillsThisRound.includes(cfg.id)) actor.usedSkillsThisRound.push(cfg.id);

    // 元素版警觉射击（3242002）：「该技能目标不会被改变」——本次行动免疫嘲讽/接触融合吸引（天赋 21840/21240 同位）
    if (cfg.id === 10331 && FC.elementExclusiveOf(actor, cfg.id)) actor.skillTargetLocked = true;

    const friendEff = FC.isFriendEff(cfg.effType);
    let targets = [];
    if ((cfg.healPct && !(cfg.power > 0)) || friendEff) { // 纯治疗/增益技；复合攻击技（healPct+power>0）按攻击技走敌方过滤
      targets = FC.targetsOfEff(cfg.effType, actor.side, units, choice.main, actor, cfg.id);
    } else {
      // 攻击技：目标集合过滤为敌方（effType 1xxx 本身只取 foes，双保险）
      targets = FC.targetsOfEff(cfg.effType, actor.side, units, choice.main, actor, cfg.id).filter(t => t.side !== actor.side);
    }
    if (!targets.length) targets = friendEff ? [actor] : (choice.main ? [choice.main] : []);
    // 10371 水神抄本：该次攻击额外覆盖与克塔亚特产生接触融合的敌方（融合=天赋 22790 绑定：她此前技能造成过伤害的目标）
    if (!friendEff && (FC.getSkillRule(cfg.id) || {}).attackFusion) {
      const fused = aliveEnemies().filter(e => !targets.some(t => t.id === e.id)
        && (e.cthyllaBoundRounds || 0) > 0 && Number(e.cthyllaBoundUnitId) === Number(actor.id));
      if (fused.length) targets = targets.concat(fused);
    }

    const effects = FC.settleSkill(actor, cfg, targets, units, null, actIndex, st);
    if (effects.wakeEffects && effects.wakeEffects.length) {
      // 三百·续：wakeEffects 是旁路出口，须过 flatten（多值单目标拆条 + 空值清 tar）
      roundEffects.push(...FC.flattenEffects(effects.wakeEffects));
    }

    // 技能衍生属性等级变化与 Buff 应用
    const skillEffs = FC.applySkillEffects(actor, cfg, targets, units, actIndex, st);
    FC.applyExclusiveCastEffects(actor, cfg, targets, effects, { units, effects: roundEffects, phase: ((actIndex || 0) * 100) + 4, curWeather: (st.weather && st.weather.start_weather) || 0, bst: st }); // P3-A/B 施放侧改写（二百二十六/二十七）
    // 10333 国土一掷（1234026）：未命中 → 对随机一名其余敌方再造成一次伤害
    const msRule = FC.getSkillRule(cfg.id);
    if ((cfg.id === 10333 && FC.elementExclusiveOf(actor, cfg.id) || (msRule && msRule.missSplash))
        && effects.length > 0 && effects.every(e => !(Number(e.hurt) > 0))) {
      const others = aliveEnemies().filter(e => !targets.some(t => t.id === e.id));
      if (others.length) {
        const t2 = others[Math.floor(Math.random() * others.length)];
        const e2 = FC.settleSkill(actor, cfg, [t2], units, null, actIndex, st);
        if (e2.wakeEffects && e2.wakeEffects.length) roundEffects.push(...e2.wakeEffects);
        const s2 = FC.applySkillEffects(actor, cfg, [t2], units, actIndex, st);
        if (s2.length) roundEffects.push(...s2);
        FC.applyExclusiveCastEffects(actor, cfg, [t2], e2, { units, effects: roundEffects, phase: ((actIndex || 0) * 100) + 4, curWeather: (st.weather && st.weather.start_weather) || 0, bst: st });
        const ppNow = ((actor.skills || []).find(s => s.id === cfg.id) || {}).pp || 0;
        fightList.push({
          atk_id: bidOfUnit(actor), skill_id: cfg.id, index: actIndex, power_point: ppNow,
          effect_list: e2.map(e => ({
            type: 0, target: bidOfUnit(units.find(u => u.id === e.target) || { bid: e.target }),
            hurt: e.hurt, final_hp: e.final_hp,
            shield_hurt: Number(e.shield_hurt) || 0, final_shield: Number(e.final_shield) || 0,
            element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
          })),
          result: 0,
        });
        actIndex++;
        log(`[element] 10333 未命中追加：sid=${actor.id} → ${t2.id}`);
      }
    }
    actor.skillTargetLocked = false; // 10331 元素版目标锁只作用于本次行动
    // 天气消费必须在施放侧之后（夜魔之宴/沐雨之祈/暗夜主宰的召唤夜幕在专属层产出）
    if (effects.weatherChange) {
      st.weather = effects.weatherChange;
      log(`[fight] 天气变更: ${st.weather.start_weather}, 持续至第 ${st.weather.weather_end_round} 回合`);
    }
    if (skillEffs.length) roundEffects.push(...skillEffs);

    // 元素唤醒·辅助技（本属性辅助技能 → 全队回血 + 下次攻击加成），直接并入本回合 effect_list
    const elHealed = applyElementSupport(actor, cfg, units, effects);
    if (elHealed) log(`[element] 唤醒辅助技 ${cfg.id}：回复 ${elHealed} 名誓灵，下次攻击 +${ELD.strengthenOf(actor.element.lv)[3]}%`);

    // 被动天赋触发（如月读「月之蚀」、天照「日之耀」、洛基「邪神业火」等）
    const talentEffs = FC.checkTalentsAfterSkill(actor, cfg, targets, effects, units, actIndex, st);
    if (talentEffs.length) roundEffects.push(...talentEffs);

    // 成就/唤灵殿堂统计：对敌伤害累计、最大单 Hit、击杀属性归因（final_hp<=0 即本次命中击杀）
    for (const e of effects) {
      const victim = units.find(u => u.id === e.target);
      if (!victim || victim.side === actor.side) continue;
      const dmg = Math.max(0, Number(e.hurt) || 0);
      if (dmg > 0) st.dmgDealt = (st.dmgDealt || 0) + dmg;
      if (dmg > (st.maxHit || 0)) st.maxHit = dmg;
      if (Number(e.final_hp) <= 0 && dmg > 0) {
        const n = cfg.nature || 0;
        st.killNature = st.killNature || {};
        st.killNature[n] = (st.killNature[n] || 0) + 1;
      }
    }
    // MVP 统计：按人归因（伤害/承伤/治疗；effects 此时已含 applyElementSupport 追加的治疗条目）
    // + 留档供回合收口差分（调研-结算详情页.md §4）
    FS.accumulateResults(st.mvpStats, actor, effects, units);
    mvpRoundLog.push({ actor, results: effects });
    // 扣技能次数（魔法箭保底次数耗尽仍可放，不再扣减）
    const sk = (actor.skills || []).find(s => s.id === choice.skillId);
    if (sk && sk.pp > 0) {
      sk.pp -= 1;
      updates.push({ type: 1, id: bidOfUnit(actor), id2: choice.skillId, val: sk.pp, vals: [] }); // wire id（客户端 dealUpdateData 按它查单位）
    }
    fightList.push({
      atk_id: bidOfUnit(actor), // wire id
      skill_id: choice.skillId,
      index: actIndex, power_point: sk ? sk.pp : 0,
      effect_list: effects.map(e => ({
        type: 0, target: bidOfUnit(units.find(u => u.id === e.target) || { bid: e.target }), hurt: e.hurt,
        final_hp: e.final_hp,
        shield_hurt: Number(e.shield_hurt) || 0,
        final_shield: Number(e.final_shield) || 0,
        element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
      })),
      result: 0, // SKILL_RESULT_SUC
    });
    actIndex++;

    // 10399 瑶草：把反伤作为瑶姬的一条独立行动下发（敌人技能动画仍聚焦原目标）
    if (effects.reflectEvents && effects.reflectEvents.length) {
      effects.reflectEvents.forEach(ev => {
        const srcUnit = units.find(u => u && Number(u.id) === Number(ev.from));
        const dstUnit = units.find(u => u && Number(u.id) === Number(ev.to));
        if (!srcUnit || !dstUnit) return;
        fightList.push({
          atk_id: bidOfUnit(srcUnit), skill_id: ev.skillId, index: actIndex, power_point: 0,
          effect_list: [{
            type: 0, target: bidOfUnit(dstUnit), hurt: ev.amount, final_hp: dstUnit.hp,
            shield_hurt: 0, final_shield: Math.max(0, dstUnit.shield || 0),
            element_shield_hurt: 0, final_element_shield: 0, extra: 0,
          }],
          result: 0,
        });
        actIndex++;
        log(`[fight] 10399 瑶草反伤：${srcUnit.id} → ${dstUnit.id} ${ev.amount}`);
      });
    }

    // 10432 羁绊连环：目标为青龙/朱雀/玄武 → 以其身份插入一条独立行动（有技能动画/伤害数字）
    if (cfg.id === 10432) {
      const bc = FC.bondChainCast(actor, targets, units, actIndex, st);
      if (bc) {
        fightList.push({
          atk_id: bidOfUnit(units.find(u => u.id === bc.castBy) || { bid: bc.castBy }),
          skill_id: bc.skillId, index: actIndex, power_point: bc.pp,
          effect_list: bc.results.map(e => ({
            type: 0, target: bidOfUnit(units.find(u => u.id === e.target) || { bid: e.target }),
            hurt: e.hurt, final_hp: e.final_hp,
            shield_hurt: Number(e.shield_hurt) || 0, final_shield: Number(e.final_shield) || 0,
            element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
          })),
          result: 0,
        });
        if (bc.effects.length) roundEffects.push(...bc.effects);
        actIndex++;
        actor.skipNextAction = true;
        log(`[fight] 10432 羁绊连环：${bc.castBy} 释放最后技能 ${bc.skillId}`);
      }
    }

    // P3 专属改写·追加施放（一百二十四/二十七泛化）：唤醒中专属行为表驱动——
    //   onKill（暴风雪/兔子退散：击败任一敌方 → 再放一次；后者追加 +70% 伤害）
    //   onMiss（升天海流 2541003 版：本次未命中 → 再放一次）
    // 官方"每回合只能触发一次且不消耗技能使用次数" ⇒ elementRefired 封顶 1 次、
    // 不扣 pp、不发 update{type:1}；目标取剩余敌人第一顺位（按技能 effType 展开目标集）。
    const exBeh = FC.elementExclusiveBehavior(actor, cfg.id)
      || ((FC.getSkillRule(cfg.id) || {}).refireOnKill ? { refire: 'onKill' } : null);
    if (exBeh && exBeh.refire && actor.side === 0 && actor.hp > 0
        && !elementRefired && aliveEnemies().length > 0) {
      const hitAny = effects.some(e => {
        const v = units.find(u => u.id === e.target);
        return v && v.side !== actor.side && (Number(e.hurt) || 0) > 0;
      });
      const killedAny = effects.some(e => {
        const v = units.find(u => u.id === e.target);
        return v && v.side !== actor.side && (Number(e.hurt) || 0) > 0 && Number(e.final_hp) <= 0;
      });
      const triggered = (exBeh.refire === 'onKill' && killedAny)
        || (exBeh.refire === 'onMiss' && !hitAny);
      if (triggered) {
        elementRefired = true;
        if (exBeh.refireMul) actor.exclusiveRefireMul = exBeh.refireMul; // 追加伤害倍率（伤害乘区链命中即消耗）
        const rTargets = FC.targetsOfEff(cfg.effType, actor.side, units, aliveEnemies()[0], actor, cfg.id)
          .filter(t => t.side !== actor.side && t.hp > 0);
        if (rTargets.length) {
          const rEffects = FC.settleSkill(actor, cfg, rTargets, units, null, actIndex, st);
          if (rEffects.wakeEffects && rEffects.wakeEffects.length) roundEffects.push(...rEffects.wakeEffects);
          const rSkillEffs = FC.applySkillEffects(actor, cfg, rTargets, units, actIndex, st);
          FC.applyExclusiveCastEffects(actor, cfg, rTargets, rEffects, { units, effects: roundEffects, phase: ((actIndex || 0) * 100) + 4, curWeather: (st.weather && st.weather.start_weather) || 0, bst: st }); // 连发同样吃施放侧改写
          if (rEffects.weatherChange) {
            st.weather = rEffects.weatherChange;
            log(`[fight] 天气变更: ${st.weather.start_weather}, 持续至第 ${st.weather.weather_end_round} 回合`);
          }
          if (rSkillEffs.length) roundEffects.push(...rSkillEffs);
          const rTalents = FC.checkTalentsAfterSkill(actor, cfg, rTargets, rEffects, units, actIndex, st);
          if (rTalents.length) roundEffects.push(...rTalents);
          for (const e of rEffects) {
            const victim = units.find(u => u.id === e.target);
            if (!victim || victim.side === actor.side) continue;
            const dmg = Math.max(0, Number(e.hurt) || 0);
            if (dmg > 0) st.dmgDealt = (st.dmgDealt || 0) + dmg;
            if (dmg > (st.maxHit || 0)) st.maxHit = dmg;
            if (Number(e.final_hp) <= 0 && dmg > 0) {
              const n = cfg.nature || 0;
              st.killNature = st.killNature || {};
              st.killNature[n] = (st.killNature[n] || 0) + 1;
            }
          }
          FS.accumulateResults(st.mvpStats, actor, rEffects, units);
          mvpRoundLog.push({ actor, results: rEffects });
          fightList.push({
            atk_id: bidOfUnit(actor),
            skill_id: cfg.id,
            index: actIndex, power_point: sk ? sk.pp : 0, // 不消耗：pp 保持主动作扣减后的值
            effect_list: rEffects.map(e => ({
              type: 0, target: bidOfUnit(units.find(u => u.id === e.target) || { bid: e.target }), hurt: e.hurt,
              final_hp: e.final_hp,
              shield_hurt: Number(e.shield_hurt) || 0,
              final_shield: Number(e.final_shield) || 0,
              element_shield_hurt: 0, final_element_shield: 0, extra: e.extra,
            })),
            result: 0,
          });
          actIndex++;
          log(`[element] 专属连发 sid=${actor.id} 技能${cfg.id} 击杀触发再次释放（本回合封顶，pp 未消耗）`);
        }
      }
    }

    // 攻击意图收口：行动者若为敌方且本次有敌方侧受击目标 → 意图定格为实际主目标；其余未行动敌方按当前战场复算
    if (actor.side !== 0) {
      const firstFoeEff = effects.find(e => { const v = units.find(u => u.id === e.target); return v && v.side !== actor.side; });
      refreshIntents(ai + 1, actor, firstFoeEff ? firstFoeEff.target : null);
    } else {
      refreshIntents(ai + 1);
    }
  }

  // 回合末异常状态伤害与持续时间自然衰减
  const endTicks = FC.settleRoundEndTicks(units, st);
  if (endTicks.length) roundEffects.push(...endTicks);
  // 21680 十香：回合末为下一回合随机敌人挂减防（在下一轮选技前可见）
  const tenkaNext = FC.applyTenkaOpeningDebuff(units, 7);
  if (tenkaNext.length) roundEffects.push(...tenkaNext);
  // MVP 统计回合收口：HP 差分兜底绕过 results 的突变（毒/燃烧/诅咒/反伤/自回/复活），守恒式：
  // 我方单位 期初HP−期末HP = Σ承伤 − Σ治疗(受疗口径)（调研-结算详情页.md §4.2）
  FS.settleRoundDiff(st.mvpStats, units, mvpHpBegin, mvpRoundLog);

  const enemiesAllDead = aliveEnemies().length === 0;
  // 战败判定（二百八十二·续 G）：官方口径 = 主力+替补全灭（FormationVO.isAllDie 双查）。
  // 主力打光但备战位还有人 → 不判负，替补上位续战。
  const hasAliveBench = Array.isArray(st.benchIds) && st.benchIds.some(id => S.servants.some(x => x.id === Number(id)));
  let alliesAllDead = aliveAllies().length === 0 && !hasAliveBench;
  log(`[fight] 波${st.batch || 1} 回合${st.round} 动作 ${fightList.length} 条；敌方余血 [${st.enemies.map(e => e.hp).join(',')}] 我方余血 [${st.allies.map(a => a.hp).join(',')}]`);
  // 替补上位必须**在本回合发包前**完成（三百零八，2026-11-05 玩家反馈「单主力被打死时报网络问题」）：
  // 客户端 onFightLoopEnd2 的判据 `(checkResult()==RESULT_NONE or slot0==nil) and checkTwoSideServant()`
  // 里 slot0 恒 nil（该函数无形参）⇒ 是否结束这一批 100% 由 gridDic（场景里还有没有我方单位）决定，
  // 与结果包到没到无关。而死亡单位在 AfterSkill→dieRemoveTrue 里就被 ReplaceUnit 摘出 gridDic。
  // 旧实现只在**下一次 select 顶部**顶替 ⇒ 客户端回放完本包时场上我方已空 → 判空 → onFightBatchEnd(nil)
  // → 报「战斗结果还没收到」并**不再发 select** ⇒ 服务端永远等不到那次触发，替补上不来、会话悬挂。
  // 现在把顶替提前到本包内：客户端 onBorn（checkEliminate→CheckNew，在 endFun 之前）会把替补
  // replaceUnit 进空格，checkTwoSideServant() 仍为真 → 正常进入下一轮。
  if (!alliesAllDead && !enemiesAllDead && aliveAllies().length === 0) {
    const moved = substituteBench(st);
    log(`[fight] 波${st.batch || 1} 回合${st.round} 场上全灭、备战位有存活 → 本包内替补上位${moved ? '' : '（未能顶上）'}`
      + `；上场后余血 [${st.allies.map(a => a.hp).join(',')}] 余备战 [${(st.benchIds || []).join(',')}]`);
  }
  // 兜底重算：替补池耗尽/悬空 id 导致顶不上时，不能推一个「我方全空」的动作包（客户端必判空报错），
  // 按真·战败处理。substituteBench 已把可用的 benchIds 全部 splice 消耗，故此处只需看场上：
  // 场上无人 ⇒ 要么本来就没替补、要么替补池也耗尽了——两种都不该继续打。
  // 正常路径（顶替成功）aliveAllies() 已 >0，此判定空转。
  alliesAllDead = aliveAllies().length === 0 && !enemiesAllDead;
  if (alliesAllDead && !enemiesAllDead) {
    // 战败：先补 m_fight_result_toc(result=LOSE 空奖励) 再 scene_result=LOSE——客户端战败面板
    //（CopyRewardPanel/RoleBuffView.checkActive）自己读 CopyMgr.getResult(fightId)，没收到结算包
    // 时 resultVO 为 nil 直接 nil 索引崩（2026-10-01 战败必现 LuaError 实证）。官方语义战败也有
    // 结算数据（0 经验 0 奖励）；战斗点未击败，玩家可调整后重新开战
    pushFightRound(conn, fightId, st.round, fightList, st.batch || 1, updates, roundEffects);
    st.over = 1; // 战败终局：后续 select 一律忽略，等玩家重新开战/撤退
    conn.sendToc('m_fight_result_toc', {
      fight_id: fightId,
      copy_id: st.copyId || currentFightPoint(),
      result: 0, // FightConst.RESULT_LOSE
      mvp: 0,
      star: [], gold: 0, silver: 0, role_exp: 0,
      servant_reward: [], item_reward: [], servant_exp: [],
      kill_num: (st.enemies || []).length,
      // 战败详情页同样有数据（CopyRewardPanel 败样式已适配；mvp=0 不亮星标）
      mvp_stats: FS.buildRows(st.mvpStats, st.allies, S.servants), score: 0, add_score: 0, replace_list: [],
    });
    conn.sendToc('m_fight_scene_result_toc', { fight_id: fightId, result: 0 });
    // 战败终局也要解除接敌（二百八十六）：fighting 残留会触发 m_move_dst_tos 的 `!S.mapState.fighting`
    // 闸门与 move_path 的截断分支，玩家重新走近这只怪永远开不了战（"怪看得见但点不进战斗"）。
    // 与 onBattleWon 的清理同口径；重试链由下一次接敌重新定格 fighting（copy_fight 捕获 monsterPos），不影响地图推进。
    if (S.mapState && S.mapState.fighting) {
      S.mapState.fighting = 0;
      conn.sendToc('m_map_fighting_monster_toc', { monster_id: 0 }); // 解除敌人头顶"战斗中"气泡
    }
    log(`[fight] 波${st.batch || 1} 我方全灭，战败（LOSE 结算包已随发）`);
    return;
  }
  if (enemiesAllDead) {
    const batches = fightBatches(st);
    const hasNextBatch = (st.batch || 1) < batches.length;
    if (hasNextBatch) {
      // 波次胜利（非最终）：scene_result 让客户端 onFightBatchEnd 走 toNextBatchAnimation
      // （转场镜头右移）→ 重发 m_fight_servant_start_tos，服务端推下一波
      pushFightRound(conn, fightId, st.round, fightList, st.batch || 1, updates, roundEffects);
      st.batch = (st.batch || 1) + 1;
      conn.sendToc('m_fight_scene_result_toc', { fight_id: fightId, result: 1 });
      log(`[fight] 波${st.batch - 1} 胜利，转场进入波${st.batch}`);
    } else {
      // 最终波胜利：结算序列在动作包之后（客户端播完动画 onFightLoopEnd → onFightBatchEnd(checkResult())，
      // checkResult 读 scene_result_toc 预存的 WIN → 结算面板）。result_toc 与 scene_result_toc 背靠背，
      // 经验/VO/星云推送全部让位到 scene_result 之后（pushFightResult 内部已保证）。
      // **整段（掉落/任务/羁绊/结算）包在 batchWrites 里**：这些子流程各自 saveState，
      // 真机单次 fsync 500~950ms，散在结算链上就会把成对协议拉开（2026-10-17 12:12:04 实证）。
      pushFightRound(conn, fightId, st.round, fightList, st.batch || 1, updates, roundEffects);
      st.over = 1; // 胜利终局：战斗会话到此结束（fightState 保留到下次开战覆盖/会话释放；
      // guide.js 兜底按 over 识别"非进行中"可安全释放出战队伍——组51 装核心依赖它，2026-10-12 E2E 实证）
      batchWrites(() => {
        // onBattleWon 的任意子流程（掉落/任务/羁绊/成就/活动）抛异常都不许吞掉结算协议：
        // m_fight_result_toc + m_fight_scene_result_toc 是客户端的**存活依赖**（缺 scene_result 时
        // onFightBatchEnd(checkResult()) 读 nil → 弹「战斗结果还没收到」且卡在战斗场景，不会自愈）。
        // 旧写法里 onBattleWon 一抛，pushFinalWinResults 整段不执行 = 必现报错 + 真卡死。
        try { onBattleWon(conn, fightId, st); } // 先算掉落（st.dropServant 供结算下发）+ 地图推进
        catch (e) { log(`[fight] onBattleWon 异常（结算包仍会下发）：${e && e.message}`); }
        pushFinalWinResults(conn, fightId);
      });
    }
  } else {
    pushFightRound(conn, fightId, st.round, fightList, st.batch || 1, updates, roundEffects);
  }
},
  },
  natureOfType: natureOfType, fightServantOf: fightServantOf, pushFightRound: pushFightRound, pushFightResult: pushFightResult, onBattleWon: onBattleWon, mapCfg: mapCfg, currentFightPoint: currentFightPoint, progressOf: progressOf, aliveMonsterNodes: aliveMonsterNodes, mapObjList: mapObjList, pushMapEnter: pushMapEnter, pushFightPrepare: pushFightPrepare, mkAllyUnit: mkAllyUnit, mkEnemyUnit: mkEnemyUnit, releaseMapSession: releaseMapSession,
  // EX 挑战关（role.js 登录链 / GM / 冒烟消费）
  isExCopyId, exRemainTimes, exDailyLoginPush, exDaily, EX_COPY_MAX_TIMES, EX_DAILY_ID, EX_UNLOCK_CHAPTER, EX_BY_NORMAL,
  // 活动助战（冒烟用；生产路径只经 pushFightRound 内部调用）
  copyTypeOf: copyTypeOf, activeAssist: activeAssist, applyAssistStart: applyAssistStart, applyAssistVuln: applyAssistVuln,
  // 章节解锁判定（二百三十六，冒烟用；生产路径 onBattleWon 登记 / closeClearedMap 消费）
  chapterOfBarrier: chapterOfBarrier, chapterUnlockedTo: chapterUnlockedTo,
};

// 释放地图会话：推 m_team_template_reset_barrier_toc 释放出战队伍（客户端 FormationModule
// 会 delNowTeamList 清 CopyMgr.nowTeamList 的"出战中"标记）+ 清地图/战斗状态。
// opts.quitToc：非 quit 协议的关闭路径（主页按钮）再补推 m_map_quit_toc——客户端
// m_map_quit_toc → updateChapter → clearNowProgressCopyID(进 1-2 被"当前正在1-1战斗中"拦死的
// 第二处残留，2026-09-30 教程完成后实测；GUIDE_FIGHT_6=25 两分支都会清，任何引导阶段安全)。
// nowTeamList 残留的后果：编队里所有誓灵被客户端 ServantUtil.isBattleNow 判成"战斗中"——
// 装圣器/核心/编队/换肤全部弹"该誓灵正在战斗中"被拦死，重登才恢复（2026-09-30 新手引导组51卡死实证）。
function releaseMapSession(conn, reason, opts = {}) {
  const ms = S.mapState;
  if (conn) conn.psMapClosePending = 0; // 任何显式释放都取消"待收尾"，避免 k 之后再补一包 close
  if (!ms) return;
  const teamIds = (ms.use_team_ids || []).filter(id => Number(id) > 0);
  if (teamIds.length) pushTeamReset(conn);
  S.mapState = null;
  S.fightState = null;
  saveState();
  if (opts.quitToc) conn.sendToc('m_map_quit_toc', { map_id: opts.quitToc });
  log(`[map] 地图会话释放（${reason}）：barrier=${ms.barrierId} 出战队伍=[${teamIds.join(',') || '无'}]${opts.quitToc ? ' +m_map_quit_toc' : ''}`);
}

// 关卡是否已全清：monsterChain 上每一只都进了 defeated。
// 只有主线探索地图带 monsterChain（40 关，1010100~1100400）；少女终末/collab/材料本/引导关都是空链，天然不受影响。
function isMapCleared(cfg, defeated) {
  const chain = (cfg && cfg.monsterChain) || [];
  if (!chain.length) return false;
  const done = defeated || [];
  return chain.every(m => done.includes(m));
}

// 关卡全清后的自动收尾（二百零九）：
// 客户端在战斗结束（onFightBatchEnd）时先发 m_map_enter_tos 请求回图（CopyUtil.backMainCopy
// 只在 RESULT_WIN 时发；真机 2026-10-22 03:39:02 实证），**随后**才打开结算/出卡面板，
// 等它们关闭后 quitFightCallback2 再发 m_map_pause_tos(0)（03:39:07）。所以本函数只在该
// pause(0) 时被调用（见 m_map_pause_tos 的登记分支），不会抢结算面板。
// 若照常回图后不管，客户端拿到的是一张**0 个可寻路目标**的地图：
// 自动寻敌 MapScene.checkAutoMove 报"后端未传输目标怪物，无法寻路"，角色愣在原地，
// 玩家只能手动点"退出该关卡"结束本次探索 —— 就是本次反馈的现象。
// 官方收尾协议是 m_map_close_toc（唯一消费方 AdventureModule.m_map_close_toc）：
//   updateChapter(map_id)（清进行中副本标记 + 刷章节/涌泉/星象馆面板）
//   → op_type==0 时派发 OPEN_COPY_CHAPTER_PANEL → CopyModule.onOpenChapterPanel
//   → openEnterPanel(TYPE_MAIN-1) 打开章节页；地图面板被 WindowsManager.onInactive 移出并暂停。
// ⚠️ ljd 文本把 onOpenChapterPanel 里的 `slot0 = slot0 or CopyMgr.nowCopyType` 整句丢了，
//    看起来像 openEnterPanel(nil-1) 会崩；asm 实证 SUBVN 前有一条 TGETS slot0 = CopyMgr.nowCopyType，
//    传 nil 安全（调研-关卡清空自动结束.md §2）。
// 释放会话不能省：不推 reset_barrier_toc，编队里所有誓灵会被客户端判"战斗中"，
// 装圣器/核心/换队全被拦死（2026-09-30 组51 卡死同款）。
function closeClearedMap(conn, barrierId, reason) {
  // 章末首通（二百三十六）：解锁事件的三连推送。消费端链路（真机 22:48 复测实证 + 反编译）：
  // ① CopyConfig.getChaptersByType 过滤 chapter <= CopyMgr.maxChapter，且 CopyMainLineView.chapters
  //    是 **initUI 一次性缓存** —— 章节页首次创建时 maxChapter 若还是登录时的旧值，本会话内
  //    新章页签永远不出现（"要重进游戏才显示下一章"的直接原因）。
  //    ⇒ **close_toc 之前**先推 m_copy_barrier_info_toc（新章屏障表），让 maxChapter 在面板
  //    initUI 之前更新（此刻面板未开，auto-open 的 isOpenEnterPanel=false 天然不触发，无副作用）。
  // ② close_toc：updateChapter 清 nowProgress + 同步开章节页（此时 chapters 已含新章）。
  // ③ m_map_info_toc{map_ids:[新章第一关]}：m_map_info_tos 全库 0 调用方（D13）= 纯服务端推送；
  //    唯一消费方 updateNowProgressCopyID 纯进度表写入（u0_5[type]=id，零副作用）。
  //    写的是选章三级回落（CopyMainLineView.getOpenSelectChapter）的第①级。
  // ④ 客户端随后的 barrier 重拉/面板刷新会触发第二次 onOpenMainView：此刻①级命中新章第一关
  //    → getCopyChapter=新章 → chapters 已含新章 → 面板落在并显示新章。
  // 重打已通章末关/非章末全清不登记不推（firstClear 门控，见 onBattleWon）。
  const unlock = conn.psChapterUnlockNext;
  const unlocking = !!(unlock && unlock.barrier === barrierId);
  if (unlocking) {
    conn.psChapterUnlockNext = null;
    const nextCh = chapterOfBarrier(unlock.next);
    const payload = mainBarrierPayload(1, nextCh);
    payload.cur_chapter = nextCh;  // 刚解锁：进度章=新章（与 maxUnlocked 一致，这里显式对齐）
    payload.max_chapter = nextCh;
    payload.chapter = nextCh;
    conn.sendToc('m_copy_barrier_info_toc', payload);
    log(`[map] 章节解锁 → m_copy_barrier_info_toc(chapter=${nextCh}, cur/max=${nextCh})：先更新 maxChapter 再建章节页`);
  }
  conn.sendToc('m_map_close_toc', { map_id: barrierId, op_type: 0 });
  if (unlocking) {
    conn.sendToc('m_map_info_toc', { map_ids: [unlock.next] });
    log(`[map] 章节解锁 → m_map_info_toc(map_ids=[${unlock.next}])：选章①级指向新章第一关`);
  }
  // ⚠️ EX 全清**绝不**重指 m_map_info_toc{map_ids:[本关]}（二百八十一曾加、三百一十四·续删）：
  // m_map_info_toc 客户端消费=CopyMgr.updateNowProgressCopyID（「进行中副本」标记，无条件写）——
  // 指回刚通关的 EX id 会把章节页骗成"这一关还在打"：CopyBarrierItem.onGUI(slot5) 隐名牌 +
  // CopyMainLineView.updateBarrier→isBattle→showServantSpine/showBattleEffect 渲染队伍站格+
  // 「战斗中」气泡 + checkGotoCopy 对其它关弹「当前正在XX战斗中」拒绝 ⇒ 玩家只能进本关点撤退
  // 清标记才能打下一关（真机截图实锤，2026-11-06）。章末解锁分支（上方）重指是安全的：
  // 它指向玩家接下来要打的下一章第一关（语义自洽，主线一直如此）。EX 模式保持由客户端自己
  // 负责：isOpenExCopy 先读 lastMainCopyId（backMainCopy 每次打赢都写），不依赖进行中标记——
  // 当年是被 ljd B6 丢赋值（isOpenExCopy 的 slot0 首句丢失）误导。
  const hadSession = !!S.mapState;
  releaseMapSession(conn, reason);
  log(`[map] 关卡已全清 → m_map_close_toc(map_id=${barrierId}, op_type=0)${hadSession ? '' : '（无会话，按存档进度判定）'}`);
}

// 小地图右下角击杀进度（AdventureMapPanel.lblLeftEnemy = now/monster，进图主动请求 + 击败后主动推）
// 计数口径必须优先用**当前会话**的 defeated：已通关关卡重打时 init_barrier 只重置
// S.mapState.defeated，prog.defeated 还是上一轮的旧值——直接用 progress 会把"0/3"显示成"3/3"。
function pushMonsterNum(conn, barrierId) {
  const cfg = MAP_CONFIGS[barrierId];
  if (!cfg) return;
  const src = (S.mapState && S.mapState.barrierId === barrierId)
    ? S.mapState.defeated
    : progressOf(barrierId).defeated;
  const defeated = (src || []).filter(m => cfg.monsterChain.includes(m)).length;
  conn.sendToc('m_copy_monster_num_toc', {
    copy_id: barrierId,
    now: defeated,              // 已击败（道中+BOSS）
    monster: cfg.monsterChain.length, // 总数
  });
}

// 胜利后处理：首掉誓灵（m_servant_update_toc 驱动客户端获取动画）+ 地图推进（怪消失/雾散/下一怪显现）
// 客户端胜利后重进地图走 m_map_enter_tos → pushMapEnter 按进度出 obj_list；
// 这里的主动推送供地图场景还活着时即时更新（死亡/散雾动画由 ON_OBJ_EXIT 的 type 驱动）
function onBattleWon(conn, fightId, st) {
  // 1. 掉落誓灵（加入 roster）
  const copyId = st.copyId || currentFightPoint();
  const cfg = mapCfg();
  const barrierId = S.mapState ? S.mapState.barrierId : 1010100;
  const prog = progressOf(barrierId);
  const firstClear = !(prog.cleared || []).includes(copyId);
  const isBoss = copyId === cfg.bossPoint;
  // 言灵录："使用X获得一次副本胜利" / "使用X通关主线N-M"（只认主线关卡 N-M）
  try {
    // 主线判据用章节表（EX 关 id 同样 %100==0 且落在 1010100~1100400 区间，旧区间判据会把
    // EX 误判成主线 → 双倍误扣/首通红点误推/言灵录"通关主线N-M"误记；chapterOfBarrier(EX id)=0）
    const isMain = chapterOfBarrier(barrierId) > 0;
    const types = (st.allies || []).map(a => {
      const b = S.servants.find(x => Number(x.id) === Number(a.id));
      return b ? Number(b.type) : 0;
    }).filter(Boolean);
    const MM = require('./moment');
    MM.onBattleWin(types, isMain ? `${Math.floor(barrierId / 10000) % 100}-${Math.floor(barrierId / 100) % 100}` : '');
    MM.checkUnlocks(conn);
  } catch (e) { /* 言灵录异常不阻塞战斗结算 */ }
  // 新手引导二战（9000001，cfg.guideCopy）：非正式关卡 —— 无银币/无道具/无任务/无成就记账，
  // 仅结算面板正常展示。官方新手流程：结算赠送小精灵并自动编入第一队
  //（guide.grantSecondFightPet：同步挂 st.dropServants 供结算展示，入队+宣告延后 3s）。见 data/guide_data.js。
  if (cfg.guideCopy) {
    st.silverReward = 0;
    require('./guide').grantSecondFightPet(conn, st);
    saveState();
    return;
  }
  // 少女终末旅行活动关（合成配置标记 actCopy）：结算钩子（**不 return**——探索地图的节点推进/
  // 击败记录/通关推送全部走主线流程；钩子只补：节点掉落 + 主线 boss 首清计数/首通货 + 周回次数扣减
  // + 面板推送 + 小千日记任务联动）
  if (cfg.actCopy) {
    if (cfg.actCopy.actId === 1742) {
      require('./act_extra').settleFantasy(conn, st, cfg);
    } else {
      require('./act_extra').settleGlastTour(conn, st, cfg);
    }
  }
  // collab 三活动关（约会大作战/究极试炼/星象馆）：结算钩子（掉落/次数/评级/章节/任务），
  // 同样不 return——下方通用掉落/地图推进对合成 collab 配置天然空转（dropServant 空、monsterChain 空）
  if (cfg.collab) {
    require('./collab').settleCollab(conn, st, cfg);
  }
  // 曜日副本（每日材料本）：奖励口径完全不同（材料掉落表 + 每日次数刷新，无誓灵掉落/无地图推进），
  // 由 handlers/daily_copy.js 结算后把 p_reward[] 挂到 st.itemRewards 供 pushFightResult 下发
  if (cfg.dailyCopy) {
    const dc = require('./daily_copy');
    const r = dc.settleRewards(conn, copyId);
    st.itemRewards = r.rewards.map(d => ({ type: d.type, num: d.num }));
    st.silverReward = r.silver;
    if (!prog.cleared.includes(copyId)) prog.cleared.push(copyId);
    // 任务推进：cond=13「通关曜日关卡N次」（args "曜日"=任意章 / "曜日修炼" 指定章）+ cond=12 通关计数
    advanceMissions(conn, { passLevel: '曜日', dailyCopy: cfg.dailyCopy.chapterName, kill: (st.enemies || []).length });
    // 活动扩展事件：战斗胜利 + 击杀 + 曜日通关（act_extra.js 世界树/绫音/拼图/集结等）
    try { require('./act_extra').actEvent(conn, 'battle', 1, null); require('./act_extra').actEvent(conn, 'kill', (st.enemies || []).length, null); require('./act_extra').actEvent(conn, 'dailyCopy', 1, null); } catch (e) { /* 忽略 */ }
    require('./achievement').onBattleStats(st, cfg); // 击杀/最大单Hit（曜日引擎同源）
    saveState();
    return;
  }
  // 唤灵殿堂（dareCopy）：战胜记账 + 28xxx 累计伤害，掉落走首通/每周两条领取链
  if (cfg.dareCopy) {
    require('./achievement').onBattleStats(st, cfg);
    require('./dare').settleRewards(conn, copyId, st);
    st.itemRewards = [];
    st.silverReward = 0; // 奖励走首通/每周领取链，战斗结算面板不掉落
    saveState();
    return;
  }
  // 成就战斗统计（主线）：击杀/按属性击杀/最大单Hit/通关N-4计数（含史莱喵通关）
  require('./achievement').onBattleStats(st, cfg);
  // 主线双倍（主线页 togDouble 开着且有持有次数）：**按整关通关扣 1 次**，本次结算全部奖励 ×2。
  // 粒度是本地服口径——一关有 5~6 个战斗点，按场扣会让 10 次双倍两关烧完（见 handlers/story_reward.js）
  const isMainStory = chapterOfBarrier(barrierId) > 0; // EX 关=0（同上，勿用区间+取模判主线）
  // 双倍：EX 关也吃（客户端 CopyPlanPanel spDouble = isMainCopy && isUseDouble，isMainCopy 只认
  // 类型 1 → EX 关显示双倍角标 ⇒ 服务端必须同样生效，否则"角标亮了奖励没翻倍"；粒度同主线=整关通关扣 1 次。
  // 但主线专属的章解锁/首通红点仍排除 EX（isMainStory 不含 EX，见下）
  const dblMul = (isBoss && (isMainStory || isExCopyId(barrierId))) ? require('./story_reward').consumeDouble(conn) : 1;
  st.doubleMul = dblMul;
  // 通关金币：根据关卡推荐等级与难度平滑递增（1-1 道中实机标定固定 10 金币；BOSS 与后续章节随难度递增）
  const chapter = Math.floor((barrierId % 1000000) / 10000) || 1;
  const stageDetail = require('../data/stage_drop_data').getStageDetail(copyId, barrierId) || {};
  const suggestLv = stageDetail.suggestLv || (chapter * 10 - 5);
  let baseSilver = 10;
  if (isBoss) {
    baseSilver = Math.round(30 + suggestLv * 6);
    if (firstClear) baseSilver += 500; // BOSS 首通额外金币
  } else {
    // 1-1 道中 suggestLv=3 -> 8 + (3 - 1) * 1.0 = 10 金币
    baseSilver = Math.max(10, Math.round(8 + (suggestLv - 1) * 1.0));
  }
  const silverGain = baseSilver * dblMul;
  S.roleAsset.silver += silverGain;
  st.silverReward = silverGain; // 结算面板金币展示项与实发同源（双倍时要显示翻倍后的数）
  pushAssetChange(conn);

  // 取被击败敌方怪物的属性（用于确定对应属性结晶掉落）
  let enemyNature = 6;
  if (st.enemies && st.enemies.length > 0) {
    const e = st.enemies[0];
    enemyNature = e.nature || (e.type ? natureOfType(e.type) : 6);
  } else if (stageDetail.enemyNature && stageDetail.enemyNature.length > 0) {
    enemyNature = stageDetail.enemyNature[0];
  }

  // 影 BOSS（EX 本影 / 主线 11 章"？？？"）无任何掉落（官方 mystery 文案"无特殊掉落"），也不进道具/誓灵掉落路
  const isShadowFight = !!(!cfg.guideCopy
    && ((cfg.ex && copyId === cfg.shadowPoint) || (cfg.shadow && copyId === cfg.shadow.point)));
  // 关卡道具掉落（按官方多槽位规则：核心模组、技能模组、遗物箱、属性结晶、进化契约、稀有项全槽位抽取）：
  // 若未被前置钩子填充（如 collab 已填并实发），则按关卡掉落配置抽取真实道具并入包；
  // 少女终末旅行活动关在钩子内已挂载 st.itemRewards，在此补齐入包
  if (isShadowFight) st.itemRewards = [];
  else if (!st.itemRewards || st.itemRewards.length === 0) {
    const itemDrops = rollStageDrops(copyId, barrierId, enemyNature, isBoss, dblMul);
    st.itemRewards = itemDrops;
    if (itemDrops.length > 0) {
      require('./vit').grantItemRewards(conn, itemDrops, 1);
      log(`[fight] 关卡掉落道具 copy=${copyId} barrier=${barrierId} isBoss=${isBoss} items=[${itemDrops.map(d => `${d.type}x${d.num}`).join(', ')}]`);
    }
  } else if (cfg.actCopy) {
    require('./vit').grantItemRewards(conn, st.itemRewards, 1);
  }

  // 计算掉落 type 列表：
  // - 新机制（dropServants 配置，如 1-4）：首通必掉 firstClear + SR/R/N 概率掉落
  // - 旧机制（rewardServant 池，如 1-1/1-2/1-3）：首通必掉或概率掉落
  // 双倍时概率掉落多摇一轮（首通必掉那只不重复给——同一只誓灵发两遍没有意义）
  const drops = [];
  if (isShadowFight) {
    // 本影不掉誓灵（掉落块整体让行，保结算面板 item/servant_reward 为空）
  } else if (copyId === cfg.bossPoint && cfg.dropServants) {
    if (firstClear && cfg.dropServants.firstClear) drops.push(cfg.dropServants.firstClear);
    for (let i = 0; i < dblMul; i++) {
      const tier = rollDropTier();
      const tierPool = (tier && cfg.dropServants[tier]) || [];
      if (tierPool.length) drops.push(tierPool[Math.floor(Math.random() * tierPool.length)]);
    }
  } else if (cfg.rewardServant && cfg.rewardServant.length) {
    if (isBoss && firstClear) {
      drops.push(cfg.rewardServant[Math.floor(Math.random() * cfg.rewardServant.length)]);
    } else {
      // 概率掉落（道中与日常周回）：BOSS 战 50% 概率，道中战 25% 概率掉落誓灵
      const dropRate = isBoss ? 0.5 : 0.25;
      if (Math.random() < dropRate) {
        drops.push(cfg.rewardServant[Math.floor(Math.random() * cfg.rewardServant.length)]);
      }
    }
  }

  if (drops.length) {
    // 非法 type（makeServantBrief 返回 null 并已记日志）必须在此剔除：
    // briefs 会被写进 m_servant_update_toc 与后续 brief/fame 推送，带出去就会毒化
    // 客户端 ServantMgr 类型计数表 → 祭坛 updateRankList 索引 nil 崩
    const briefs = [];
    const firstFlags = []; // 与 briefs 平行：is_first=该 type 图鉴未激活（先判后建卡——makeServantBrief 会激活图鉴）
    for (const dropType of drops) {
      const first = handbookMod.isUnlocked(dropType) ? 0 : 1;
      const brief = makeServantBrief(dropType);
      if (!brief) continue;
      firstFlags.push(first);
      require('./servant').grantServantBrief(brief);
      if (!prog.dropped) prog.dropped = [];
      if (!prog.dropped.includes(dropType)) prog.dropped.push(dropType); // barrier_info 的 servant_types（已掉落图鉴标记）
      briefs.push(brief);
    }
    // 这些实例服务端已入档，但 m_servant_update_toc 要延迟 3s 才告知客户端（下方 setTimeout）。
    // 期间 pushFightResult → pushServantChanges → pushFameUpdates 绝不能引用它们
    //（客户端 ServantMgr 查不到 sid → 祭坛选人 VO.configVO=nil → 名气榜排序崩）。
    altarMod.markPendingAnnounce(briefs.map(b => b.id));
    // 言灵录："获得X"（含"获得X超过N天"的计时起点）——掉落即刻记获得时间并判定解锁
    try {
      const MM = require('./moment');
      MM.onServantObtained(briefs.map(b => Number(b.type)));
      MM.checkUnlocks(conn);
    } catch (e) { /* 言灵录异常不阻塞掉落 */ }
    try {
      const urCount = briefs.filter(b => Math.floor(b.type / 10000) % 10 === 4).length;
      require('./act_extra').actEvent(conn, 'gain', briefs.length, { ur: urCount });
    } catch (e) { /* 忽略 */ }
    // p_kvt 数组：结算面板 servant_reward 展示（多只也支持）。
    // 用 briefs 的实际 type（而非 drops）构造——非法 type 已被剔除，
    // 否则结算面板会展示一只根本没发到手的誓灵
    st.dropServants = briefs.map(b => ({ id: Number(b.type), val: 1, type: 1 }));
    st.dropServant = st.dropServants[0] || null;
    // 获取动画：m_servant_update_toc(new:[{servant,is_first}], reward_type=2 COPY) →
    // 客户端 ServantMgr.addServant + OutCardMgr.addNewServants → OutCardPanel 播卡片动画。
    // 结算面板有掉落展示，动画延后播（避免盖在战斗表现上）
    setTimeout(() => {
      conn.sendToc('m_servant_update_toc', {
        // is_first=图鉴未激活（重复 SR/UR 掉落照样弹动画——客户端稀有度分支，但无 NEW 角标）
        new: briefs.map((s, i) => ({ servant: s, is_first: firstFlags[i] })),
        update: [],
        del: [],
        reward_type: 2, // ServantConst.REWARD_TYPE_COPY
      });
      altarMod.clearPendingAnnounce(briefs.map(b => b.id)); // 先宣告实例，再补推名气
      // 新誓灵入列 → 阵营名气上涨，diff 推祭坛 fame update（客户端会刷新红点/供奉选人列表）
      altarMod.pushFameUpdates(conn);
      // 新誓灵 → 图鉴激活红点（makeServantBrief 已记账，这里补推送；打开图鉴列表时清零）
      handbookMod.pushRedPoints(conn);
    }, 3000);
    log(`[fight] 掉落 barrier=${barrierId} copy=${copyId} types=[${drops.join(',')}]`);
  }
  if (!isShadowFight && !prog.cleared.includes(copyId)) prog.cleared.push(copyId);
  // EX 每日次数：按整关通关计（与双倍粒度同决策），BOSS 点 clear 时 +1 并推增量
  // （客户端 getExCopyRemainTimes = 3 - dailyTimes(20004)，lblExTimes"次数：x/3"）
  if (copyId === cfg.bossPoint && isExCopyId(barrierId)) {
    exDaily().used += 1;
    saveState();
    pushExDailyUpdate(conn);
    log(`[ex] EX 通关计数 barrier=${barrierId} 今日=${S.exState.used}/${EX_COPY_MAX_TIMES}`);
  }
  // 影击败：链外打点 —— 不进 prog.cleared（波次 id 允许不连续）、不进 chain/击杀计数，
  // 只记 shadowDefeated（重进图不复活）+ 显形物件隐藏推送 + 影点雾消散（11 章 fogAfter 键=影点）
  if (isShadowFight) {
    prog.shadowDefeated = true;
    saveState();
    const shadowPos = (cfg.ex && cfg.ex.hlBossPos) || (cfg.shadow && cfg.shadow.pos);
    const shadowObjs = [{ id: shadowPos, type: cfg.ex && cfg.ex.hlBossPos ? 7 : 2, val: 0 }];
    [].concat(cfg.fogAfter[shadowPos] || []).forEach(fog => shadowObjs.push({ id: fog, type: 5, val: 2 }));
    conn.sendToc('m_map_obj_update_toc', { objs: shadowObjs });
    // ★ 接敌态必须解除（三百一十四）：影格不在 monsterChain ⇒ 下方链内击败块整段跳过，
    // S.mapState.fighting 残留影格 → m_move_dst_tos 的 `!S.mapState.fighting` 闸门把**下一只怪**
    // 的接敌整段吞掉（点怪毫无反应，玩家只能退出重进——EX 每轮 3 星必打本影 ⇒ 必现）。
    // 与链内击败（下方 fighting=0 + toc(0)）和战败终局（二百八十六）同口径。
    // 不推击杀计数/不推 find_monster：本影不占计数、不在搜寻链（smoke_ex 5.10 既有断言）。
    if (S.mapState) S.mapState.fighting = 0;
    conn.sendToc('m_map_fighting_monster_toc', { monster_id: 0 });
    const shadowFogs = [].concat(cfg.fogAfter[shadowPos] || []);
    log(`[ex] 本影击败 pos=${shadowPos}（不占击杀数，不影响全清，雾散=${shadowFogs.join(',') || '无'}）`);
  }
  // BOSS 战斗点通关 → 新功能解锁（通关1-2 → 协会）。
  // m_function_update_toc 客户端会合并进开启列表并派发 FUNCTION_UPDATE_STATE，无需重登
  if (copyId === cfg.bossPoint) {
    // 章末首通（二百三十六）：登记章节解锁事件，close 收尾时消费（closeClearedMap）。
    // 客户端选章三级回落（CopyMainLineView.getOpenSelectChapter，asm 实证无丢赋值）：
    // 进行中副本标记 → lastMainCopyId → curChapter。close_toc 处理会清掉前者，而
    // lastMainCopyId（backMainCopy 写入，本会话内唯一写点）钉死在刚打完的旧章 ——
    // 不推 m_map_info_toc 重指，auto-open 分支重开面板后仍落在旧章，要重登才见新章。
    if (isMainStory && firstClear) {
      const nextCh = chapterUnlockedTo(barrierId);
      if (nextCh) conn.psChapterUnlockNext = { barrier: barrierId, next: MAIN_CHAPTERS[nextCh][0] };
    }
    const funcs = buildOpenFunctions();
    setTimeout(() => conn.sendToc('m_function_update_toc', { functions: funcs }), 3500);
    log(`[func] 通关 barrier=${barrierId}，解锁功能: [${funcs.join(',')}]`);
    // 信仰开关活动 1041（誓灵详情「信仰」按钮显隐）：只在 6-4 通关后下发，
    // 且客户端只在 m_role_acts_toc 里认它 ⇒ 通关当轮必须主动重推一次活动表，
    // 否则玩家要退回主城/重登才看到「信仰」按钮（调研-信仰.md §3.2）。
    if (barrierId === require('./activity').FAITH_UNLOCK_BARRIER) {
      setTimeout(() => { try { require('./activity').pushRoleActs(conn); } catch (e) { /* 忽略 */ } }, 3550);
      log('[faith] 6-4 通关 → 重推活动表（解锁 1041，誓灵详情出现「信仰」按钮）');
    }
    // 阵型解锁（通关 1-4/2-4/3-4/4-4/5-4 → 护卫/侧翼A/侧翼B/单纵/单纵改）：
    // 客户端 CopyMgr.lineUpData 是会话级缓存，不重推则新阵型要重登才出现在布阵面板
    setTimeout(() => pushLineupIfChanged(conn), 3600);
    // 首通奖励红点：本关刚变成"通关了但没领" → 章节页签要亮红点。
    // 客户端 m_copy_story_red_point_toc 是纯推送（无 tos），不推则要重登才出现
    if (isMainStory) setTimeout(() => require('./story_reward').pushRedPoint(conn), 3700);
    // 羁绊：出战誓灵概率涨羁绊（客户端台词原文"(出战可概率增加羁绊值)"，
    // 概率/数量/每日上限客户端一个字都没有 → 见 data/feeling_rules.js 的本地服设计值）。
    // 按**整关通关**触发，不是每场道中战——否则一关能刷 5~6 次
    require('./feeling').addBattleFeeling(conn, (st.allies || []).map(a => a.id));
    // 休息位结算（二百七十四）：战斗期间休息誓灵的满足度/收集照常流逝，整关通关时一并结清，
    // 让玩家打完回主城就能看到气泡。锚点制重复调用零增量，异常不阻塞结算链。
    try { require('./feeling').restSettle(conn); } catch (e) { /* 忽略 */ }
  }
  // 2. 地图推进：monsterPos 优先用开战时定格的接敌节点（fighting 可能被移动重置）
  const monsterPos = (st && st.monsterPos) || (S.mapState && S.mapState.fighting);
  if (monsterPos && cfg.monsterChain.includes(monsterPos)) {
    if (!S.mapState) S.mapState = { barrierId, lastId: 1, pos: cfg.bornPos, fighting: 0, zone: 0 };
    if (!S.mapState.defeated) S.mapState.defeated = [];
    if (!S.mapState.defeated.includes(monsterPos)) S.mapState.defeated.push(monsterPos);
    S.mapState.fighting = 0;
    prog.defeated = S.mapState.defeated.slice();
    saveState();
    // 怪死亡(val=0) → 雾散(val=2 DISAPPEAR 播放散开动画)；其余存活怪保持可见（进图时已下发）
    const objs = [{ id: monsterPos, type: 2, val: 0 }];
    const fogs = [].concat(cfg.fogAfter[monsterPos] || []); // 数组=同触发点多片雾（10-4）
    fogs.forEach(fog => objs.push({ id: fog, type: 5, val: 2 }));
    conn.sendToc('m_map_obj_update_toc', { objs });
    conn.sendToc('m_map_fighting_monster_toc', { monster_id: 0 }); // 解除战斗态恢复小队
    pushMonsterNum(conn, barrierId); // 击败后刷新小地图右下角击杀进度（客户端有被动 handler，主动推即时更新）
    pushFindMonster(conn); // 刷新自动搜寻目标列表（死掉的要摘掉，否则自动寻敌往尸体走）
    const next = cfg.monsterChain.find(m => !S.mapState.defeated.includes(m));
    log(`[map] 击败 monster=${monsterPos}，雾散=${fogs.join(',') || '无'}，下一怪=${next || '无(通关)'}`);
    // 通关重推剧情播放记录：图鉴按通关推导解锁，不重推要重登才生效
    conn.sendToc('m_theatre_info_toc', { list: playedTheaters() });
    // 任务推进：通关指定/任意关卡 + 击败誓灵数（道中按敌人波次近似）。
    // EX 关：args 形态是"挑战模式X-X"（cfgmission cond52 实文），且要推进 cond55"任意挑战模式"
    const bId = S.mapState ? S.mapState.barrierId : 1010100;
    if (isExCopyId(bId)) {
      const exLv = `挑战模式${Math.floor(bId / 10000) % 100}-${Math.floor(bId / 100) % 100 - 10}`;
      advanceMissions(conn, { exPassLevel: exLv, kill: (st.enemies || []).length });
    } else {
      const lvName = `${Math.floor(bId / 10000) % 100}-${Math.floor(bId / 100) % 100}`;
      advanceMissions(conn, { passLevel: lvName, kill: (st.enemies || []).length });
    }
    try { require('./act_extra').actEvent(conn, 'battle', 1, null); require('./act_extra').actEvent(conn, 'kill', (st.enemies || []).length, null); } catch (e) { /* 忽略 */ }
    // 挑战关卡 1706：胜利记通关 + 首通奖励（战斗本体复用当前地图点，见 m_copy_fight_tos 的捕获）
    try { require('./act_extra').settleSeventh(conn); } catch (e) { /* 忽略 */ }
    // 结社贡献不在这里给：官方口径是"每消耗 1 点体力 = 1 点本周贡献"，
    // 已改到出击扣体力时结算（handlers/vit.js spendSortieVit）
  } else {
    saveState();
  }
}

// 通用兜底：任何未处理的 *_tos 若存在同名 *_toc 则回默认填充。
// 没有同名 toc schema 的也必须回一个包：客户端 ErrorMgr.checkSendBack 对每个
// 非静默 tos 启动 1 秒计时器，任何 toc 到达都会重置；完全不回包会让
// NetWaitPanel（loading 转圈）在操作中频繁弹出（如 m_role_handbook_play_cv_tos、
// m_theatre_play_tos 都无 toc schema）。m_common_reply_toc proto_id=0 客户端静默忽略
