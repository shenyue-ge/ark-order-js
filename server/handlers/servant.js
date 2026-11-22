// 誓灵/皮肤/编队/看板娘（重构自 start.js）
const fs = require('fs');
const path = require('path');
const { S, saveState, servantBagSize } = require('../state');
const L = require('../lib');
const { log, defaultFill, bagTypeOf, pushGoodsUpdate, normSlots, VALID_ITEM_TYPES, pushAssetChange, pushServantChanges, CHANGE_ID_EXP, CHANGE_ID_LEVEL, CHANGE_ID_STATUS, CHANGE_ID_OVERSTEP, TRAIN, grantGoods, relicFieldsOf, faithFieldsOf } = L; // 解构导入，域内裸调用与单文件时代一致
const ED = require('../data/energy_data');
const { energyFieldsOf, energySum, feedGainOf } = ED;
const FC = require('../data/fight_core');
const CH = require('../data/chaos_data');
const EV = require('../data/evolution_rules'); // 进化（升星）：星级门槛/材料需求/替代品折算
const BK = require('../data/break_data');      // 突破（overstep）：吃誓灵数/金币/界限突破材料/官方错误码
const { SERVANT_SKILLBOOK, skillLearnItemOf } = require('../data/skill_data');

// ---- 技能装备位（技能页签 listEquip 的 A/B/C 三槽）----
// 官方链路：p_servant_detail.using_skill（3 元素，0=空槽）驱动装备栏；
// 装备/卸下/拖拽交换全部走 m_servant_skill_op_tos{servant_id, skill_id, pos, team_id}。
// 无字段时懒初始化为技能书默认技（state.loadState 迁移同口径，覆盖运行期新获得誓灵）
function usingSkillsOf(b) {
  if (!Array.isArray(b.using_skills) || b.using_skills.length !== 3) {
    const defs = FC.defaultSkills(b.type);
    b.using_skills = [defs[0] || 0, defs[1] || 0, defs[2] || 0];
  }
  return b.using_skills;
}

// 已学集合（detail.skill 下发口径）：默认技(lv=0) ∪ learned_skills。
// 客户端 studySkills 据此判定技能页签掩码与"装 备"按钮（isStudy），默认技必须算已学——
// 官方新誓灵出生即已学自带技，否则会出现"已装备却显示可学习"的矛盾态
function knownSkillIds(b) {
  const ids = FC.defaultSkills(b.type);
  const berserk = CH.berserkOf(b);
  if (berserk && CH.levelOf(b, 2002) && !ids.includes(Number(berserk.skills))) ids.push(Number(berserk.skills));
  (Array.isArray(b.learned_skills) ? b.learned_skills : []).forEach(id => {
    const n = Number(id);
    if (n > 0 && !ids.includes(n)) ids.push(n);
  });
  return ids;
}

const SKIN_CFG = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skin_config.json'), 'utf8'));
    return { types: j.types || {}, itemToSkin: j.itemToSkin || {}, live2dSkins: j.live2dSkins || [] };
  } catch (e) { return { types: {}, itemToSkin: {}, live2dSkins: [] }; }
})();
const { MAP_CONFIGS } = require('../data/map_configs');

// 阵型启用场位表（CfgCopy.arrays，data/lineup_data.js 统一维护）：lineup 1-6 → 该阵型可站立的格子编号
const { LINEUPS, LINEUP_POS } = require('../data/lineup_data');

// 编队对象（p_formation；客户端 updateFormationInfo 按单对象访问）
function buildFormation(idx, saved) {
  const f = saved || {};
  // 悬空 id 出口防御：field/bench 里指向已不存在誓灵的 id（历史存档/漏清引用）不下发——
  // 统一清成 0（空位），数组长度不变；客户端结算面板对悬空 id 建卡会 roster 查无 nil 索引崩溃
  const aliveIds = new Set((S.servants || []).map(s => s.id));
  const cleanSlots = arr => Array.isArray(arr)
    ? arr.map(id => { const num = Number(id); return (num > 0 && !aliveIds.has(num)) ? 0 : num; })
    : arr;
  const field = cleanSlots(normSlots(f.field)), bench = cleanSlots(normSlots(f.bench));
  // 阵型编号 1-6；客户端 changeLineup 用它索引 lineupDataList，0 会 nil 崩布阵面板；
  // 未解锁的编号（存档脏数据/GM 撤销强制解锁）回落 1 突击
  const lineup = unlockedLineups().includes(Number(f.lineup)) ? Number(f.lineup) : 1;
  // 布阵面板（CopyPlanView.updatePositions/getTeamMemberNum）读 fight_field/fight_bench 渲染场上站位/替补，
  // 全空会让面板空白且点开始提示"当前队伍是空的"——为空时用 field/bench 填充
  const fightField = cleanSlots(normSlots(Array.isArray(f.fight_field) && f.fight_field.length ? f.fight_field : field));
  const fightBench = cleanSlots(normSlots(Array.isArray(f.fight_bench) && f.fight_bench.length ? f.fight_bench : bench));
  // positions[i] = 第 i 个主力的场位格编号（1-6）；为空时按当前阵型给默认站位
  let positions = Array.isArray(f.positions) ? f.positions.map(Number).filter(n => n >= 1 && n <= 6) : [];
  if (!positions.length) positions = LINEUP_POS[lineup] || LINEUP_POS[1];
  // S.servants 始终由 field/bench 重建：客户端 getTeamCost 直接 getTeamServant(id).attr.hp，
  // 下发空 S.servants（存档缺键/脏数据）会 nil 索引崩编队界面；teamServantOf 已带满血 attr
  const fServants = field.filter(id => id > 0).map(id => teamServantOf(id, 1, idx))
    .concat(bench.filter(id => id > 0).map(id => teamServantOf(id, 0, idx)))
    .filter(Boolean);
  const builtServants = fServants.length ? fServants : (f.servants || []);
  // 会话级"战斗中"标记（二百八十二）：status **由存活会话推导**，不在存档落位。任何 p_formation
  // 载荷（info 应答/briefs/info_toc 组/reset_barrier/拖拽回包/copy_team）都从这里出——真机实证：
  // 双队进关后中途开编队面板，被查看队伍的编队数据拉取/回包把客户端 VO 的锁洗成 0 ⇒ 主战队伍
  // 无"战斗中"标记、可替换誓灵（2026-10-31 用户反馈）。releaseMapSession 先清 locked 再建 teams，
  // 保证 reset_barrier 载荷 status=0（客户端重建 VO 即去锁）。
  const lockedNow = !!(S.mapState && S.mapState.locked &&
    (S.mapState.use_team_ids || []).map(Number).includes(Number(idx)));
  return Object.assign(defaultFill('p_formation'), f, {
    index: idx,
    name: f.name || '',
    field,
    bench,
    positions,
    lineup,
    servants: builtServants,
    status: lockedNow ? 1 : (f.status || 0),
    fight_field: fightField,
    fight_bench: fightBench,
  });
}

// ---- 阵型（Lineup）解锁与下发 ----
// 解锁判定与 FUNC_UNLOCK 同口径（进度 cleared 含该关 bossPoint）；1 号突击阵型默认开启。
// lineupState.touched=已点掉 new 角标的阵型；forced=GM 强制解锁；synced=已同步给客户端的解锁集
//（通关解锁后必须重推 info：客户端 CopyMgr.lineUpData 是会话级缓存，布阵面板只在首次打开时拉取）
function unlockedLineups() {
  const st = S.lineupState || {};
  return LINEUPS.map(l => l.id).filter(id => {
    if (id === 1) return true;
    if ((st.forced || []).includes(id)) return true;
    const barrier = (LINEUPS.find(l => l.id === id) || {}).unlock;
    if (!barrier) return false;
    const cfg = MAP_CONFIGS[barrier];
    return cfg ? (L.progressOf(barrier).cleared || []).includes(cfg.bossPoint) : false;
  });
}

// m_servant_lineup_info_toc：list 元素 = 阵型id*10 + new 标记（CopyMgr.initLineUp 按 floor(id/10)/id%10 解包，
// new=1 时布阵面板阵型图标亮红点）
function pushLineupInfo(conn) {
  const st = S.lineupState || (S.lineupState = {});
  const list = unlockedLineups().map(id => id * 10 + ((st.touched || []).includes(id) ? 0 : 1));
  st.synced = unlockedLineups().slice();
  saveState();
  conn.sendToc('m_servant_lineup_info_toc', { list });
  log(`[lineup] 推送阵型列表: [${list.join(',') || '空'}]`);
}

// 通关 BOSS 后调用：解锁集变化（新通关 1-4/2-4/… 或 GM 解锁）才重推
function pushLineupIfChanged(conn) {
  const st = S.lineupState || (S.lineupState = {});
  const now = unlockedLineups();
  const prev = st.synced || [];
  if (now.length !== prev.length || now.some(id => !prev.includes(id))) {
    pushLineupInfo(conn);
    return true;
  }
  return false;
}

// 释放出战队伍：退出/撤退关卡时推 m_team_template_reset_barrier_toc，
// 客户端 FormationModule 会 delNowTeamList(teams[].index) 清"出战队伍"标记。
// 缺失会导致客户端 CopyMgr.nowTeamList 残留，去其他关卡提示"该队伍正在战斗中"。
// 编队面板锁的释放也收口在这里：reset 的 teams[] p_formation.status 本身就是 0
//（buildFormation 读 f.status||0，status 从不持久化），客户端 updateFormationInfo 重建 VO
// 时自然清掉"战斗中"角标；这里再显式补一条 m_team_update_status_toc(val:0) 双保险，
// 不依赖 reset 的消费顺序。unlock 先行、reset 收尾。
// 位 8（战斗位）的"置位名册"：init_barrier 置位时登记的 battleBitIds ∪ 出战队伍当前 field∪bench。
// 为什么要登记：官方允许关卡中编辑布阵（CopyPlanPanel 不读锁），会话存活期间编队换人会让
// "置位时的名册"与"释放时现算的名册"不同——只按现算清位，被换出者永久带位 8，玩家被派遣
// 206001 拒到重启为止（2026-10-31 实锤：14:51 置位的 90000012 于 14:58 被换出，位 8 残留）。
// 记录名册 + 并集清除是对抗名册漂移的收口；位 8 的真相源判定见 dorm.js healBusyBits。
function battleRosterOf(ms) {
  const set = new Set(((ms && ms.battleBitIds) || []).map(Number));
  for (const tid of (ms && ms.use_team_ids) || []) {
    const rf = S.formations[Number(tid)];
    if (!rf) continue;
    for (const sid of [].concat(rf.field || [], rf.bench || [])) {
      if (Number(sid) > 0) set.add(Number(sid));
    }
  }
  return [...set];
}

function pushTeamReset(conn) {
  // 去重：客户端正常不会发重复队伍（CopySortiePanel 已选中的队不可再选），防御性收敛——
  // unlock 包与 reset teams 都按去重后的列表回推（原样 map 会把同一队下发多份）
  const ids = [...new Set(((S.mapState && S.mapState.use_team_ids) || []).map(Number))].filter(id => id > 0);
  // ⚠️ 必须先清 locked 再 buildFormation（二百八十二）：status 由存活会话推导，先建后清会让
  // reset_barrier 的 teams[].status=1——客户端 updateFormationInfo 重建 VO 反而把"战斗中"锁上
  if (S.mapState) S.mapState.locked = 0; // 只清锁标记；会话可能继续存活（glast/collab 结算路径）
  const teams = ids.map(idx => buildFormation(idx, S.formations[idx]));
  if (teams.length) {
    conn.sendToc('m_team_update_status_toc', { updates: ids.map(id => ({ id, val: 0 })) });
    conn.sendToc('m_team_template_reset_barrier_toc', { teams });
    // 战斗位（bit3=8）清除，与 init_barrier 置位对称（二百八十二·续 E）：field+bench 全员。
    // 按登记名册 ∪ 现算名册清（battleRosterOf）——只按现算会漏掉会话中途被换出的成员（本条）。
    // 先落盘后推送（D22）；key:3 推送驱动客户端 VO.status 刷新，isBattle/isBattleNow 随之解除。
    const battleOff = [];
    for (const sid of battleRosterOf(S.mapState)) {
      const sb = S.servants.find(x => Number(x.id) === sid);
      if (!sb) continue;
      const cur = Number(sb.status) || 0;
      if ((cur & 8) === 8) { sb.status = cur & ~8; battleOff.push({ servant_id: sb.id, key: CHANGE_ID_STATUS, val: sb.status }); }
    }
    if (battleOff.length) { saveState(); pushServantChanges(conn, battleOff); }
    log(`[team] 释放出战队伍 [${ids.join(',')}]`);
  }
}



// 元素精灵装备态（p_servant_detail.element_id / p_team_servant.element_id）：
// 值是**物品 gid**（客户端 ServantPropRelicView 直接 BagMgr.getItem(elementID)），0=未携带。
// 装备的实例若已不在包里（被卖/被还原）→ 回落 0，避免下发悬空 gid 让客户端拿到 nil VO。
function elementGidOf(b) {
  if (!b || !Number(b.element_gid)) return 0;
  return S.bagGoods.some(g => Number(g.id) === Number(b.element_gid)) ? Number(b.element_gid) : 0;
}

// p_team_servant（由 brief 数据生成，is_field：1=上阵 0=替补）
// teamId：信仰套装归属的编队号（0=誓灵本体套装 faiths、1-4=该编队的独立套装 faithTeams）。
// 默认 0（大多数调用点是"看某只誓灵"的语境）；buildFormation 显式传所在队伍号。
function teamServantOf(id, isField, teamId) {
  const b = S.servants.find(s => s.id === id);
  if (!b) return null;
  return {
    id: b.id,
    type: b.type,
    skin_id: b.skin_id,
    star: b.star,
    max_level: 100,
    overstep: b.overstep,
    level: b.level,
    is_field: isField,
    status: Number(b.status) || 0,
    status2: Number(b.status2) || 0,
    pl: 0,
    // 元素精灵：客户端 FormationServantVO.elementID ← element_id（编队卡片/战斗唤醒都读它）。
    // 与 p_servant_detail.element_id 同源（S.servants[].element_gid），不分编队 —— 一只精灵只能装一只誓灵。
    element_id: elementGidOf(b),
    fight_skill: usingSkillsOf(b).map(id => {
      const pp = id > 0 ? (FC.skillCfg(id) || {}).pp || 30 : 0;
      return { skill_id: id, power_point: pp, max_power_point: pp };
    }),
    // attr schema 标 array of p_attr 但客户端按单对象访问（HeadHpItem 直接 .hp/.max_hp），
    // 空数组会解码为 nil → 地图队伍血条 onGUI 算术崩溃，且渲染 tween 中断只显示第一个小人
    attr: Object.assign(defaultFill('p_attr'), {
      hp: 1000, max_hp: 1000,
      phy_atk: 120, mag_atk: 120, phy_def: 60, mag_def: 60,
    }),
    buffs: [],
    // 编队誓灵必须带真实 energy_points：客户端 FormationServantVO.initByFormation 用
    // `table.toDic(slot1.energy_points,"id","val")` 建**独立副本** energyPointDic，恒发空数组
    // 会让编队页（FormationTeamItem.updateEnergy）与编队态详情面板的能源条永远显示 Lv0
    //（2026-10-17 azhi 真机：同一誓灵主 VO 15 点、编队 VO 0 点，两份数据源不一致）。
    energy_points: energyFieldsOf(b).energy_points,
    // 编队誓灵同样携带装备态（FormationServantVO.initByFormation 读 relic_id/power_relic 建 coreDic）
    ...relicFieldsOf(b),
    // 元素精灵装备态（FormationServantVO.elementID ← element_id）
    element_id: elementGidOf(b),
    // 信仰（FormationServantVO.initByFormation 读 faith → faithMapVO 9 格棋盘 + 链接加减成）
    ...faithFieldsOf(b, teamId),
  };
}



// 该誓灵是否在任何编队里（主力/替补/布阵槽都算）。
// 突破吃誓灵时的可选素材过滤 = 客户端 ServantConfigVO.canUse()（status==0 且 isTeamAll()==false）
function servantInAnyTeam(id) {
  const n = Number(id);
  for (const idx of Object.keys(S.formations || {})) {
    const f = S.formations[idx] || {};
    for (const key of ['field', 'bench', 'fight_field', 'fight_bench']) {
      if (Array.isArray(f[key]) && f[key].some(x => Number(x) === n)) return true;
    }
  }
  // 银匙之门布阵（独立于主线编队）也算占用
  const emb = (S.dreamState && S.dreamState.embattle) || {};
  return Object.values(emb).some(x => Number(x) === n);
}

// 客户端背包与存档脱钩时的兜底：按物品 id 反推背包页签，**整包重推** m_goods_bag_info_toc。
// 为什么需要：突破/进化的"材料够不够"完全由客户端本地算（BagMgr.getItemNum），服务端只回一个
// 221001「材料不足」——玩家看到的就是"面板显示 100/80 可点，点下去说不够"这种无法自证的矛盾。
// m_goods_bag_info_toc 在客户端是 updateBags→addBag（**整包替换**），幽灵格/过期数量一次清干净，
// 等价于玩家自己去打开那个背包页签。任何"扣了东西没推包"的遗漏都由这里收口（二百六十九）。
function resyncMatBags(conn, itemIds) {
  try {
    const BAG = require('./bag');   // 延迟 require：bag.js 反向依赖 servant 的装备索引
    const types = new Set((itemIds || []).map(id => bagTypeOf(id)));
    for (const t of types) BAG.handlers.m_goods_bag_info_tos(conn, { type: t });
  } catch (e) {
    log(`[bag] 材料不足时重推背包失败：${e.message}`);
  }
}

// 把已删除/已吃掉的誓灵（ids）从全部引用处清掉：编队四数组位→0、爬塔队槽→0、
// 探索队/看板娘组剔除、看板娘指针回落。返回清理的引用数。
// 漏清的悬空 id 会随 p_formation.fight_field 下发，客户端结算面板
//（CopyRewardServantItem.onGUI）对它建卡时 roster 查无 → LuaError nil 索引
//（其他玩家实测报错 Modules/Copy/View/CopyRewardServantItem: attempt to index a nil value）。
function scrubServantRefs(ids) {
  const dead = new Set((ids || []).map(Number));
  if (!dead.size) return 0;
  let n = 0;
  for (const f of Object.values(S.formations || {})) {
    for (const key of ['field', 'bench', 'fight_field', 'fight_bench']) {
      if (Array.isArray(f && f[key])) {
        f[key] = f[key].map(id => {
          const num = Number(id);
          if (num > 0 && dead.has(num)) { n++; return 0; }
          return id;
        });
      }
    }
  }
  const tw = S.towerState && S.towerState.team;
  if (tw && tw.slots) {
    for (const slot of Object.keys(tw.slots)) {
      if (dead.has(Number(tw.slots[slot]))) { tw.slots[slot] = 0; n++; }
    }
  }
  for (const tn of Object.keys((S.arkState && S.arkState.teams) || {})) {
    const list = S.arkState.teams[tn];
    if (Array.isArray(list)) {
      const before = list.length;
      S.arkState.teams[tn] = list.filter(id => !dead.has(Number(id)));
      n += before - S.arkState.teams[tn].length;
    }
  }
  S.helperIdList = (S.helperIdList || []).filter(id => !dead.has(Number(id)));
  if (S.helperState && dead.has(Number(S.helperState.lastHelper))) {
    S.helperState.lastHelper = S.helperIdList[0] || (S.servants[0] && S.servants[0].id) || 0;
    n++;
  }
  // 休息位（S.dormState.servants：残留会让 dormServantList 发 skin_id=0 → 客户端
  // "配置不存在的类型:0"刷错，D16 族）与派遣位（S.dormState.troops：D20 自愈口径）。
  const dormSv = Array.isArray(S.dormState && S.dormState.servants) ? S.dormState.servants : null;
  if (dormSv) {
    const before = dormSv.length;
    S.dormState.servants = dormSv.filter(s => !dead.has(Number(s && s.servant_id)));
    n += before - S.dormState.servants.length;
  }
  const troops = Array.isArray(S.dormState && S.dormState.troops) ? S.dormState.troops : null;
  if (troops) {
    const before = troops.length;
    for (const t of troops) {
      if (!Array.isArray(t && t.servant_ids)) continue;
      t.servant_ids = t.servant_ids.filter(id => !dead.has(Number(id)));
    }
    // 全员被清的队伍整个移除：领奖按 crusade_id 查空 → 210001 拒绝（D20 错误码口径），安全
    S.dormState.troops = troops.filter(t => Array.isArray(t && t.servant_ids) && t.servant_ids.length > 0);
    n += before - S.dormState.troops.length;
  }
  // 名片展示编队（二百八十一）：被分解/删除的誓灵清槽（0=空位），否则 info_toc 下发
  // 不存在的 id → 客户端 ServantMgr.getServant(id)=nil → RoleOutCardsItem.onGUI 读 .skinID 崩
  if (Array.isArray(S.showTeamState && S.showTeamState.servants)) {
    for (let i = 0; i < S.showTeamState.servants.length; i++) {
      if (dead.has(Number(S.showTeamState.servants[i]))) { S.showTeamState.servants[i] = 0; n++; }
    }
  }
  return n;
}

// 计算某誓灵所在的队伍编号列表（1..4 升序数组）。
// 对应客户端 ServantConfigVO.getTeamId(slot1) 与 FormationMgr 编队组1：
// 誓灵在编队1中返回 [1]，在编队2中返回 [2]；客户端据此显示"队伍:N"角标并支撑编队优先排序
function teamsOfServant(servantId) {
  const n = Number(servantId);
  if (!n || !S.formations) return [];
  const teams = [];
  for (let t = 1; t <= 4; t++) {
    const f = S.formations[t];
    if (!f) continue;
    let found = false;
    for (const key of ['field', 'bench', 'fight_field', 'fight_bench']) {
      if (Array.isArray(f[key]) && f[key].some(x => Number(x) === n)) {
        found = true;
        break;
      }
    }
    if (!found && Array.isArray(f.servants)) {
      if (f.servants.some(s => s && Number(s.id) === n)) {
        found = true;
      }
    }
    if (found) {
      teams.push(t);
    }
  }
  return teams.sort((a, b) => a - b);
}

// 编队组归属（CfgFormation.formationInfo，与 m_team_template_info_tos 的 GROUPS 同口径）：
// 1-4=组1（主线老编队）、501-504/511-514/521-524/531-534=组2-5（自由编队1-4）、
// 551-558=组6-13（唤灵殿堂）、559/560=组14-15（信仰对决）。
function formationGroupOf(idx) {
  const n = Number(idx) || 0;
  if (n >= 1 && n <= 4) return 1;
  if (n >= 501 && n <= 534) return 2 + Math.floor((n - 501) / 10);
  if (n >= 551 && n <= 560) return n - 545;
  return 0;
}

// 同组移动语义（149006 族，二百八十二·续 F）：官方模型是**组内**一灵一队——客户端
// FormationSelectPanel.replaceServantToTeam 对"选中的誓灵已在同组其他队"弹
//「是否将 X 从队伍A 更换至 队伍B」确认框后仍发本协议 ⇒ 服务端语义是**移动**（从旧队移除）。
// 跨组合法共存（ServantConfigVO.teamIdList 是数组、m_servants_change_teams_toc 下发 list；
// 唤灵殿堂 copy_team 跨组复制即此模型），不动。返回被移除的编队号列表（调用方补推编队数据）。
function stripServantFromSameGroup(sid, keepIdx) {
  const n = Number(sid);
  const group = formationGroupOf(keepIdx);
  if (!n || !group || !S.formations) return [];
  const removed = [];
  for (const key of Object.keys(S.formations)) {
    const idx = Number(key);
    if (idx === Number(keepIdx) || formationGroupOf(idx) !== group) continue;
    const f = S.formations[key];
    const field = normSlots(f.field), bench = normSlots(f.bench);
    const nf = field.map(id => (Number(id) === n ? 0 : id));
    const nb = bench.map(id => (Number(id) === n ? 0 : id));
    if (nf.join(',') !== field.join(',') || nb.join(',') !== bench.join(',')) {
      f.field = nf;
      f.bench = nb;
      f.servants = nf.filter(id => id > 0).map(id => teamServantOf(id, 1, idx))
        .concat(nb.filter(id => id > 0).map(id => teamServantOf(id, 0, idx)))
        .filter(Boolean);
      removed.push(idx);
      log(`[formation] 同组移动：sid=${n} 从队伍 ${idx} 移除（并入队伍 ${keepIdx}）`);
    }
  }
  return removed;
}

// 同步所有誓灵的 team_ids 并比对出产生变化的誓灵 ID 列表
function syncServantTeamIds() {
  if (!Array.isArray(S.servants)) return [];
  const changedIds = [];
  for (const s of S.servants) {
    if (!s) continue;
    const currentTeams = teamsOfServant(s.id);
    const oldTeams = Array.isArray(s.team_ids) ? s.team_ids : [];
    const isSame = oldTeams.length === currentTeams.length &&
      oldTeams.every((tid, idx) => tid === currentTeams[idx]);
    if (!isSame) {
      s.team_ids = currentTeams;
      changedIds.push(s.id);
    } else {
      s.team_ids = currentTeams;
    }
  }
  return changedIds;
}

// 下发编队队伍变动通知 m_servants_change_teams_toc
function pushServantsTeamChanges(conn, changedIds) {
  if (!conn || !Array.isArray(changedIds) || changedIds.length === 0) return;
  const changeList = changedIds.map(id => {
    const s = (S.servants || []).find(x => x && x.id === id);
    return {
      id: id,
      list: (s && Array.isArray(s.team_ids)) ? s.team_ids : [],
    };
  });
  conn.sendToc('m_servants_change_teams_toc', { change_list: changeList });
  log(`[servant] 推送编队队伍变更 m_servants_change_teams_toc: count=${changeList.length} ${JSON.stringify(changeList)}`);
}


// 注：2026-11-05 起「自动锁定」不再按来源标记过滤 N/R（见 m_servant_lock_tos 的注释），
// 原先的 autoLockTargets（Map<servantId, expire>）+ registerPendingAutoLock 已无读取方，
// 一并删除以免留下误导性的"死标记"（指南 A3：误诊遗留物会变成永久死补丁）。

// 入档查重发放：brief.id 与 S.servants 现有实例撞号时拒收（记日志）。
// 客户端 addServant 对已存在 id 仍计数 +1（bc asm 实证）——重复入档+brief 双发
// 会造成「类型计数>0、实例列表空」，破除后祭坛 fame 推送必崩（2026-10-14 真机）。
// nextServantId 回退（存档迁移/GM 误操作）是撞号主源，这里同步抬升分配器。
function grantServantBrief(b) {
  if (!b) return null;
  const id = Number(b.id);
  if (S.servants.some(s => Number(s.id) === id)) {
    log(`[servant] ⚠ 拒绝入档重复实例 id=${id} type=${b.type}（S.servants 已有同 id）`);
    const maxId = S.servants.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
    if (S.nextServantId <= maxId) S.nextServantId = maxId + 1; // 分配器回退时立即抬升
    return null;
  }
  S.servants.push(b);
  return b;
}

// ---- 誓灵 type 合法性（客户端 CfgServant 白名单）----
// 客户端 ServantMgr.addServant（bc asm 实证）对「类型计数表」是**无条件 +1**，
// 但只有在 ServantConfig.getServantConfigVO(type) ~= nil 时才真正建 VO 并入实例列表。
// 两者不一致时，祭坛 ServantAltarDetailVO.updateRankList 遍历计数表、却用
// getTopLevelServant(type) 查实例列表 → 取到空表 → `.level` 索引 nil →
// m_servant_type_fame_update_toc 处理期崩溃（真机 2026-09-23 强化/训练/突破报错）。
// 因此任何下发给客户端的誓灵都必须先在白名单内，否则宁可不发也不能毒化客户端状态。
const ST_ALL = require('../data/servant_types');
const isValidServantType = ST_ALL.isValidServantType;

// 全量 brief 过滤：登录推送 / GM 加誓灵等"重建客户端 roster"的路径都走这里
function briefableServants(list) {
  const out = [];
  const seenIds = new Set(); // 重复实例 id 查重：客户端 addServant 对已存在 id 仍计数 +1（bc asm 实证），
  for (const b of list || []) { // 同 id 下发两次会让类型计数与实例列表错位 → 破除后祭坛名气榜必崩（2026-10-14）
    if (seenIds.has(Number(b && b.id))) {
      log(`[servant] 过滤重复实例 id=${b && b.id}（brief 内重复下发会毒化客户端类型计数表）`);
      continue;
    }
    if (b && b.id) seenIds.add(Number(b.id));
    if (isValidServantType(b && b.type)) { out.push(b); continue; }
    log(`[servant] 过滤非法誓灵 type=${b && b.type}（客户端 CfgServant 无此 typeId，`
      + `会毒化 ServantMgr 类型计数表 → 祭坛名气榜崩）；id=${b && b.id} 不下发`);
  }
  return out;
}

function makeServantBrief(type) {  // 获得誓灵 ⇒ 图鉴激活（含狂化派生；幂等。延迟 require 解循环依赖）
  if (!isValidServantType(type)) {
    // 绝不静默建卡：非法 type 一旦入 S.servants 就会被 brief / fame 推送带出去毒化客户端
    log(`[servant] 拒绝创建非法誓灵 type=${type}（不在客户端 CfgServant，共 ${ST_ALL.VALID_SERVANT_TYPE_LIST.length} 个合法 type）`);
    return null;
  }
  if (!ST_ALL.isObtainableServantType(type)) {
    // 官方"仅敌人"伪誓灵（尤格/莎布/奈亚/克苏/辛西娅/杂鱼光）：客户端无 starItems/图鉴/凭证配置，
    // 持有即坏誓灵小屋红点链（canEvolution → pairs(getServantStarUpgradeInfo().items) 每次渲染崩，
    // 见 调研-GM一键获取誓灵带出敌方伪誓灵.md）。本函数是全部 15 处发放路径的唯一 choke point。
    log(`[servant] 拒绝创建敌方伪誓灵 type=${type}（官方仅敌人：无升星/图鉴/凭证配置，持有即坏誓灵小屋）`);
    return null;
  }
  try { require('./handbook').onServantObtained(type); } catch (e) { /* 图鉴失败不阻塞发卡 */ }
  const b = {
    id: S.nextServantId++,
    type: type,
    name: '',           // 空串客户端解码为 nil → 回退配置名
    // 出生星级：ServantConfigVO.ctor 的 star 初值 = 2，starItems 也从 [2] 起（2→3/3→4/4→5 三档进化）。
    // 2026-08-26 之前这里写死 5（当时进化未实装，5 星让 canEvolution 直接短路、绕开查表 nil.cost 崩），
    // 进化落地后必须回到官方口径，否则誓灵一出生就满星、进化功能与进化皮肤全无从触发
    star: EV.BASE_STAR,
    overstep: 0,
    level: 1,
    dream_lv: 0,
    exp: 0,
    skin_id: type * 100 + 1,  // VO ctor 默认皮肤公式 typeId*100+1；发 0 会覆盖默认导致立绘加载失败
    status: 0,
    status2: 0,
    team_ids: [],
    skill: [],
    learned_skills: [], // 已学习技能（技能面板/战斗技能栏都从这里下发）
    rage_skill: CH.rageSkillOf({ type }), // 幻梦默认怒气技（重登前直接进银匙之门不报 skillID=0）
    // 羁绊（handlers/feeling.js）：feeling=当前羁绊值、satisfaction=升下一点的进度条 0~100、
    // feeling_record=里程碑时间戳 [{id:50|100, val:unix秒}]、pledge_time>0 才算已缔结灵契
    feeling_record: [],
    feeling: 0,
    satisfaction: 0,
    pledge: 0,
    pledge_time: 0,
    message: '',            // 灵契寄语（p_servant_detail.message；空则客户端显示默认寄语）
    change_name_time: 0,    // 上次改昵称时间（30 天 CD，客户端本地也算一遍）
    filter_value: 0,
    act_rage_skill: [],
    gain_time: Math.floor(Date.now() / 1000),
    power: 0,
    fame: 0,
    relic_gid: 0,   // 已装备圣器（物品 gid；装备系统见 handlers/relic.js）
    element_gid: 0, // 已装备元素精灵（物品 gid；见 handlers/element.js）
    cores: {},      // 已装备能力核心 {属性码1-6: 物品 gid}
    // 能源页签初始态：每属性上限 6（loadState 迁移同口径；运行期新获得也必须带，否则 detail 全 0 上限）
    energy_ceils: ED.ENERGY_PROPS.reduce((o, p) => (o[p] = ED.ENERGY_INIT_CEIL, o), {}),
    energy_points: {},
  };
  return b;
}

// 编队 briefs 的 4 支队伍全量下发（m_servant_formation_briefs_tos 应答体 + VO 重建后的重同步共用）
function sendFormationBriefs(conn) {
  const briefs = [];
  const last = [];
  for (let i = 1; i <= 4; i++) {
    briefs.push(buildFormation(i, S.formations[i]));
    last.push({ id: i, val: i }); // p_kvi 字段是 id/val
  }
  conn.formationBriefsSent = true;
  conn.sendToc('m_servant_formation_briefs_toc', { briefs: briefs, last_indexs: last });
  // briefs 会重建旧编队 1-4 的 VO（p_formation.status 恒 0），把 info 应答尾部补的锁洗掉；
  // 本应答可能晚于 info 到达（客户端 onEnterGame 先 info 后 briefs），按同一 locked 条件
  // 幂等补推（新编队 501+ 只有 info 链覆盖，info 处的补推已够，两边各管各的 VO 集）。
  const msLock = S.mapState;
  if (msLock && msLock.locked) {
    const lockIds = [...new Set((msLock.use_team_ids || []).map(Number))].filter(id => id > 0);
    if (lockIds.length) {
      conn.sendToc('m_team_update_status_toc', { updates: lockIds.map(id => ({ id, val: 1 })) });
    }
  }
}

const COMPACT_BRIEF_MIN = 24;

// 首屏精简 brief 覆盖的实例 id：看板娘组 + 四支编队全员 + 少量补位（空队/新档也能建 VO）。
// ⚠️ 这个集合必须对外可查（servant.briefedIds）：精简包之外誓灵的实例 id 对客户端来说
//    **尚未宣告**，任何"按实例 id 反查 VO"的协议都不能引用它们（祭坛 fame 表 p_kvt.type
//    就是典型，见 handlers/altar.js 的 notBriefed 过滤）。
function compactIds() {
  const ids = new Set(helperOrderIds().map(Number));
  for (const f of Object.values(S.formations || {})) {
    for (const key of ['field', 'bench', 'fight_field', 'fight_bench']) {
      for (const id of (f && Array.isArray(f[key]) ? f[key] : [])) if (Number(id) > 0) ids.add(Number(id));
    }
  }
  for (const s of S.servants) { if (ids.size >= COMPACT_BRIEF_MIN) break; ids.add(Number(s.id)); }
  return ids;
}

// 当前连接已向客户端宣告过的誓灵实例 id 集合。
// 只要推过 brief（全量或精简）就返回集合——全量包宣告的是 briefableServants 产出的
// "真正下发"子集，会话中途静默入档（token 发卡 conn=null 等）的实例不在其中。
// 从未推过 brief 返回 undefined，语义为"未知，调用方自行决定"（登录前不会触发 fame 推送）。
function briefedIds(conn) {
  if (!conn || !conn.servantsBriefSent) return undefined;
  const ids = conn.briefedIds;
  if (!ids) return undefined;
  // 兜底：精简包路径下编队中途换人会把新 id 带进后续包，这里始终并入当前精简集合
  if (conn.servantsBriefCompact) {
    for (const id of compactIds()) ids.add(id);
  }
  return ids;
}

function pushServantsBrief(conn, opts) {
  // 顺序关键：MainFunctionPanel.update 监听 SERVANTS_BRIEF_TOC 事件，brief 到达即触发 onChangeHelp；
  // 若组/helper 还未到（RoleMgr.updateHelpGroup 未执行），getGroupList() 为空 → getServant(nil) 崩。
  // 所以必须先推看板娘组（m_role_profile_helper_toc + m_role_profile_info_toc），最后推 brief。
  const compact = !!(opts && opts.compact);
  // ⚠️ 同一连接重推全量 brief = 毒化客户端类型计数表（2026-10-17 azhi 真机实证）：
  // 客户端 initServantInfo 只重置 uv1/uv2，**不清 uv0 类型计数表**；随后对每个已存在实例
  // 调 addServant，其计数是**无条件 +1**（bc asm；ljd 明文丢了这行）→ 每重推一次，每个
  // 类型的计数再翻一倍、实例列表不变。失衡后任何 fame 推送都在
  // ServantAltarDetailVO.updateRankList 取空表 `.level` 崩。
  // 所以：首次推送走全量（重建 roster）；已推过则改增量（m_servant_update_toc{new}）。
  // 调用方若确实需要"客户端丢掉旧 VO 重来"（如新手选灵后编队重建），传 { forceFull: true }。
  const forceFull = !!(opts && opts.forceFull);
  if (!compact && conn && conn.servantsBriefSent && !forceFull) {
    const ids = pushPendingServants(conn);
    log(`[servant] 重推全量 brief 已降级为增量宣告（${ids.length} 只），避免客户端类型计数翻倍`);
    // 增量后仍需编队 briefs 重同步（新实例可能进编队）
    if (conn.formationBriefsSent) sendFormationBriefs(conn);
    return;
  }
  const ids = compact ? compactIds() : null;
  conn.servantsBriefSent = true;
  conn.servantsBriefCompact = compact;
  conn.briefedIds = conn.briefedIds || new Set();
  if (compact) {
    for (const id of ids) conn.briefedIds.add(id);
  }
  // 全量包同样记账：briefableServants 会剔除非法 type/重复 id——被剔除的实例**没有真正宣告**，
  // 不能当"客户端已持有"。会话中途静默入档（如 GM 商店誓灵代币走 collab.grantServant(null)）
  // 的实例也不在集合里，fame 推送按 briefedIds 过滤就不会把它带出去（2026-10-16 D7 第四变体）。
  if (S.servants.length > 0) {
    pushHelperGroup(conn);
  }
  // 幻梦等级的「暗噬成长线」兜底值 dream_lv 随真实等级变化，下发前统一刷新——
  // 面板 "Lv.N(a+b)" 的绿字部分与服务端幻梦战算力必须同源（见 data/dream_rules.js dreamGrowthOf）
  require('../data/dream_rules').syncDreamLv(S.servants);
  // 同步所有誓灵当前所在的队伍列表（1..4），确保客户端收到最新 team_ids 支撑编队置顶与队伍角标
  syncServantTeamIds();
  let list = S.servants;
  if (compact) {
    list = S.servants.filter(s => ids.has(Number(s.id)));
  }
  const sent = briefableServants(list); // 实际下发的集合（非法 type/重复 id 已剔除）
  for (const b of sent) conn.briefedIds.add(Number(b.id));
  conn.sendToc('m_servants_brief_toc', {
    size: S.servantBagSize || 100,
    servants: sent,
  });
  // 客户端 initServantInfo 每次收 brief 都**整体重建**全部 VO（attr 等字段清零）；
  // 若编队 briefs 已发过（会话中途重推，如 GM 加誓灵），必须紧跟重发一次让客户端
  // updateFormationInfo 在新 VO 上重跑 initByFormation 把 attr/fightSkills 补回来——
  // 否则曜日/活动副本点进入时客户端预检 isAllDie 取 slot6.attr.hp 直接 LuaError
  if (conn.formationBriefsSent) {
    sendFormationBriefs(conn);
  }
}

// 补齐精简 brief 未下发的誓灵（增量宣告）。
//
// 动机：精简包是安卓登录性能优化（123 只 → 24 只，8.4KB → 1.7KB），但它留下一个看不见的洞——
// 客户端 ServantMgr 里根本不存在那些誓灵的 VO。祭坛 m_servant_type_fame_list_toc 的
// p_kvt.type 是"名气最高实例的 servant id"，客户端 updateServantSelectVODicByType 用
// ServantMgr.getServant(type) 反查 VO 建 ServantAltarSelectItemVO；查不到就是 configVO=nil，
// 紧接着 m_altar_info_toc → updateRankList → 排序 getFame() 索引 nil → LuaError
// （真机 2026-10-10 Pad 7 实测：72 个类型里 53 个实例未宣告，登录必崩）。
// PCJS 走全量 brief 所以从不复现。
//
// 返回"已精简 brief、但尚未向客户端宣告"的誓灵（按 S.servants 顺序）。
// 空数组 = 客户端已持有全部实例（全量 brief 路径，或补齐已完成）。
function pendingBriefServants(conn) {
  const briefed = briefedIds(conn);
  if (!briefed) return [];
  return (S.servants || []).filter(b => !briefed.has(Number(b.id)));
}

// 宣告 up to `max` 只尚未宣告的誓灵，返回本次宣告的实例 id 数组。
// 用官方 m_servant_update_toc 的 reward_type=1：客户端 handler 在该值时只走
// ServantMgr.addServant，不进 OutCardMgr 弹卡分支 —— 不会误弹"获得誓灵"动画。
// 全量包路径下同样有意义：会话中途静默入档（token 发卡等）的实例由此补宣告。
function pushPendingServants(conn, max) {
  const briefed = briefedIds(conn);
  if (!briefed) return [];           // 从未推过 brief：无法增量（正常登录链推过才到这里）
  const pending = pendingBriefServants(conn);
  if (!pending.length) return [];
  const part = pending.slice(0, Math.max(1, Number(max) || pending.length));
  conn.sendToc('m_servant_update_toc', {
    new: part.map(b => ({ servant: b, is_first: 0 })),
    update: [],
    del: [],
    reward_type: 1,
  });
  for (const b of part) briefed.add(Number(b.id));
  return part.map(b => Number(b.id));
}

// help_list 元素形状 p_helper_brief {id, gain_time, feeling}（getGroupList 取 .id）

// 看板娘组顺序：最后切换的看板娘放首位（客户端登录显示 groupList[MainMgr.helpIndex=1]，
// 即 help_list[1]；updateHelpGroup 也会把 RoleMgr.helper 设为首位 id）。
// 组语义（勾选 ≤5 只）与默认单元素兜底统一在 lib.helperOrderIds（登录 ack 的 helper_list 同源）
function helperOrderIds() {
  return L.helperOrderIds();
}

function pushHelperGroup(conn) {
  const ids = helperOrderIds();
  const helpList = ids.map(id => {
    const s = S.servants.find(x => x.id === id);
    return { id: s.id, gain_time: s.gain_time, feeling: s.feeling };
  });
  conn.sendToc('m_role_profile_helper_toc', { help_list: helpList });
  // helper 字段 = 客户端 RoleMgr.helper（主页首显经补丁定位到它）——直接回最后切换的看板娘
  conn.sendToc('m_role_profile_info_toc', { intro: S.profileIntro || '', helper: S.helperState.lastHelper || ids[0] });
}



// p_servant_detail 构造（单只 detail 与列表 detail 共用）
function servantDetailOf(b) {
  require('../data/dream_rules').syncDreamLv([b]); // 幻梦等级绿字（暗噬成长线兜底）随等级刷新
  b.team_ids = teamsOfServant(b.id); // 保证 detail 的 team_ids 也是最新的
  // detail 必须继承 brief 的全部同名字段（尤其 star/skin_id/name）——
  // defaultFill 的 star=0 会经 initByDetail 覆盖列表值，canEvolution 再度查表崩溃
  return Object.assign(defaultFill('p_servant_detail'), b, {
    chaos: CH.chaosArrayOf(b),
    rage_skill: CH.rageSkillOf(b),
    status: Number(b.status) || 0,
    status2: Number(b.status2) || 0,
    // 邂逅日（ServantFeelVO.ownTime ← p_servant_detail.type_gain_time）：缺字段时客户端
    // `slot1.type_gain_time or 0` → formatSecToDate(0) = 1970年1月1日（羁绊页/ServantFeelItem
    // 相遇行都读它）。brief（p_servant_brief）schema 没有该字段 ⇒ initByBrief 后恒 0 是官方
    // 形状，羁绊页打开必拉 detail（ServantInfoPanel.toGetDetailInfo → initByDetail 覆盖），
    // 所以 detail 是唯一修复点。语义取实例获得时间（=gain_time；ServantMgr 同 type 排序
    // tiebreaker 也按它升序）。存档无需迁移：全量实例本就带 gain_time，派生下发
    type_gain_time: Math.floor(Number(b.gain_time) || 0),
    skill: knownSkillIds(b), // 已学技能（含默认技）：客户端 initByDetail 存 studySkills（掩码/装备按钮判定）
    using_skill: usingSkillsOf(b), // 装备中 3 槽（0=空槽）：技能页签装备栏直接渲染；空数组=整栏空白
    power: require('../data/ark_data').servantPower(b), // 战斗力（天空方舟探索队/指令战读 VO.power；登录另有 key=15 批量推）
    // 装备字段（relic_gid/cores 是存档内部名，协议名不同，须显式映射）
    ...relicFieldsOf(b),
    // 元素精灵（p_servant_detail.element_id）：ServantConfigVO.commonInit 映射成 elementID，
    // 缺它则重登后"携带的精灵"消失、装备槽显示未携带（2026-10-23 元素精灵接通）
    element_id: elementGidOf(b),
    // 信仰（ServantConfigVO.initByDetail → initFaithMap(slot1.faith)，id=pos/val=gid）。
    // 详情面板/信仰面板读的是誓灵本体套装（team_id=0），编队页签另有 m_faith_equip_info_toc 覆盖
    ...faithFieldsOf(b, 0),
    // 能源页签：energy(各属性上限)/energy_points(已分配点)。全空上限会让面板
    // point/ceil 出 0/0=NaN 且无处可加点（initByDetail 建 energyCeilDic/energyPointDic）
    ...energyFieldsOf(b),
  });
}

// ---- 皮肤面板数据负载（m_servant_skin_tos 回包与缔结灵契后的主动补推共用）----
// com_skin=已拥有的普通皮肤（初始+按星级的进化皮肤），priv_skin=激活道具皮肤。
// 灵契皮肤（actItemID==1，getWayID=20，客户端 getWayStr="缔结灵契"）：客户端归属**只**认本协议
// 的 com_skin+priv_skin 合并列表（setCurrSkinInfo → updateOwnSkin 标 isOwn），"激活"按钮查的
// 道具 id=1 不存在恒不可用 ⇒ 不下发就永久"未激活"。归属按 lib.isTypeMarried 派生（type 级、
// 免迁移），与 S.skinState.owned（GM/商店静态解锁）取并集。
function skinTocPayload(b, sid) {
  const list = (b && SKIN_CFG.types[b.type]) || [];
  const star = EV.normStar(b && b.star);
  const typeMarried = !!(b && L.isTypeMarried(b.type));
  const com = [], priv = [];
  for (const sk of list) {
    if (sk.actItemID > 0) {
      if (S.skinState.owned.includes(sk.skinID) || (sk.actItemID === 1 && typeMarried)) priv.push(sk.skinID);
    } else if (sk.getWayID === 0 || (sk.getWayID >= 3 && sk.getWayID <= 5 && star >= sk.getWayID)) {
      // 初始皮 + 已达星级的进化皮（getWayID 3/4/5 = 三/四/五星进化皮肤）——
      // 进化 star+1 后客户端把皮肤 VO 标 dataIsOK=false 重发本协议，新皮肤即自动出现
      com.push(sk.skinID);
    }
  }
  const def = (list.find(s => s.getWayID === 0) || {}).skinID;
  const cur = (b && b.skin_id) || def || 0;
  return { servant_id: sid || (b && b.id) || 0, cur_skin: cur, com_skin: com, priv_skin: priv };
}

// 缔结灵契成功后主动补推皮肤面板数据（仅该 type 有灵契皮时）。
// 客户端皮肤 VO 缓存 dataIsOK=true 后不再重拉（全客户端唯一重置点是进化 toc），不推的话
// 缔结前开过皮肤面板的本会话会一直显示"未激活"直到重登；handler 只做 setCurrSkinInfo +
// updateInfoPanel，无弹窗、无面板互斥。刻意不用 m_servant_shop_active_skin_toc——它会
// 0.4s 后必弹 NewSkinPanel，可能顶掉正在播放的婚礼 CG（D14 家族风险）。
function pushMarrySkinRefresh(conn, b) {
  if (!b || !(SKIN_CFG.types[b.type] || []).some(s => s.actItemID === 1)) return false;
  conn.sendToc('m_servant_skin_toc', skinTocPayload(b, b.id));
  return true;
}

module.exports = {
  handlers: {
m_servants_brief_tos(conn) {
  pushServantsBrief(conn);
},
m_servant_detail_tos(conn, obj) {
  const b = S.servants.find(s => s.id === obj.servant_id);
  if (!b) { log('[servant] detail 请求未知 id', obj.servant_id); return; }
  conn.sendToc('m_servant_detail_toc', { servant: servantDetailOf(b) });
},
// 誓灵锁定/解锁（ServantModule.toLock / toLocks）：
// op_type: 1 锁定（status 最低位置 1），0 解锁（status 最低位清 0）
// 状态变更推 m_servants_change_toc（key=3 CHANGE_ID_STATUS）驱动客户端 VO 刷新，
// 操作应答回 m_servant_lock_toc 驱动客户端弹 Tips 与更新面板
m_servant_lock_tos(conn, obj) {
  const ids = Array.isArray(obj && obj.servant_ids) ? obj.servant_ids.map(Number) : [];
  const opType = Number(obj && obj.op_type) || 0;
  const changes = [];
  const successIds = [];
  let hadAutoLockFilter = false;
  let hasStateChanged = false;

  for (const id of ids) {
    const s = S.servants.find(x => x.id === id);
    if (!s) continue;

    // 锁定操作（opType === 1）稀有度过滤的**唯一适用场景**（2026-11-05 重定口径）：
    // 只拦「批量自动锁定」——即客户端由 toLocks 批量发起、玩家没有逐只确认的那条链
    // （OutCardPanel.onClickBtnSkip → OutCardMgr.filterUrServant 的跳过、十连结算批量）。
    // N/R 是突破/喂养/遣散材料，批量锁上会让玩家必须先逐只解锁才能当材料用（一百三十一）。
    //
    // 反例（修复前误判）：ids.length > 1 被当成"自动锁定"的判据，导致
    //   a) 单只新誓灵的自动锁定靠 autoLockTargets 标记判 isAuto ⇒ N/R 被静默跳过；
    //   b) 玩家在「是否锁定新获得的誓灵」弹窗里**明确点了"是"**（onClickBtnOk →
    //      togLock.IsOn = true → onLockChange → toLock 单只），仍命中 (a) 被否决。
    //   表现为"弹了框、开关也动了，出去看还是没锁"，且服务端只留一行
    //   `ids=[] ... (已过滤N/R级自动锁定)`、**不回任何 toc**（客户端无从纠正 UI）。
    //   N/R 的桥姬 1311009 / 鸦天狗 1313011 因此 100% 复现；SR/UR 从不触发 ⇒ "概率有用"其实是按稀有度确定分叉。
    //
    // 新口径：**玩家的明确意图优先**。弹窗点"是"与详情页手点同属"手动"，任意稀有度一律允许；
    // 只有真正的批量（ids.length > 1）才按 N/R 过滤。单只自动锁定（抽卡/掉落/开箱各一条
    // m_servant_update_toc{new:[一只]} → 客户端 toLocks([id]) 也只有一个元素）不再过滤。
    if (opType === 1) {
      const color = Math.floor(Number(s.type) / 10000) % 10;
      if (ids.length > 1 && color <= 2) {
        hadAutoLockFilter = true;
        continue; // N/R 稀有度只在批量自动锁定时静默跳过，不置位 status bit 0
      }
    }

    const oldStatus = Number(s.status) || 0;
    const newStatus = (opType === 1) ? (oldStatus | 1) : (oldStatus & ~1);
    if (oldStatus !== newStatus) {
      s.status = newStatus;
      hasStateChanged = true;
    }
    // 强一致性自愈兜底：凡是有效处理的誓灵，无论服务端原状态是否已与 newStatus 相同，
    // 都必须加入 changes 向客户端补推 m_servants_change_toc（key=3 CHANGE_ID_STATUS），
    // 彻底消除客户端因编队覆盖/脏缓存等原因造成的假未锁定死循环态
    changes.push({ servant_id: s.id, key: CHANGE_ID_STATUS, val: newStatus });
    successIds.push(s.id);
  }
  if (hasStateChanged) {
    if (S.formations && typeof S.formations === 'object') {
      for (const idx of Object.keys(S.formations)) {
        const f = S.formations[idx];
        if (f && Array.isArray(f.servants)) {
          for (const sv of f.servants) {
            if (sv && Number(sv.id)) {
              const master = S.servants.find(x => x.id === sv.id);
              if (master) {
                sv.status = Number(master.status) || 0;
                sv.status2 = Number(master.status2) || 0;
              }
            }
          }
        }
      }
    }
  }
  if (changes.length > 0) {
    pushServantChanges(conn, changes);
  }
  if (successIds.length > 0 || !hadAutoLockFilter) {
    conn.sendToc('m_servant_lock_toc', { servant_ids: successIds, op_type: opType });
  } else {
    // 整批被 N/R 过滤（successIds 空 ∧ hadAutoLockFilter）：绝不能回 lock_toc 空表
    // ——那会弹「锁定成功」却什么都没锁（D11 同款静默失败伪装成功）。
    // 回 common_reply 让 handler 有出站（D2 不变量），客户端 doNotPrintToc 静默忽略。
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
  }
  // 落盘放在回包之后（二百二十一）：saveState 是全同步写（写 .tmp + 拷 .bak + rm + rename），
  // 真机实测单次 500~950ms。抽卡后「跳过」会连发这条 tos，若先落盘再回包，客户端 3 秒预算
  // 会被磁盘吃掉 ⇒ 弹「服务端未响应」。与 handleSummon（回包在 saveState 之前）保持同一范式。
  if (hasStateChanged) saveState();
  log(`[servant] 誓灵${opType === 1 ? '锁定' : '解锁'}：ids=[${successIds.join(',')}] op_type=${opType}${hadAutoLockFilter ? ' (批量已过滤N/R级)' : ''}`);
},
// 誓灵背包扩容（ServantModule.toListExtend）：
// 客户端确认框花 50 水晶 +5 上限；回执 m_servant_list_extend_toc{ size: newSize }
// ⚠️ 与 bag.m_extend_bag_tos 同族（2026-10-30 二百七十六 一并修）：
//   余额口径 = GlobalData.gold = payGold + givenGold，仅看 roleAsset.gold 会把
//   "水晶全在赠送档"的玩家误判成不足；扣费先扣赠送再扣付费（旧实现 gold -= cost 多扣一份）。
m_servant_list_extend_tos(conn, obj) {
  const cost = 50;
  const payGold = Number(S.roleAsset.gold) || 0;
  const givenGold = Number(S.roleAsset.gold_given) || 0;
  if (payGold + givenGold < cost) {
    conn.sendToc('m_common_tips_toc', defaultFill('m_common_tips_toc'));
    log(`[servant] 誓灵背包扩容失败：水晶不足（${payGold}+${givenGold} < ${cost}）`);
    return;
  }
  const fromGiven = Math.min(givenGold, cost);
  S.roleAsset.gold_given = givenGold - fromGiven;
  S.roleAsset.gold = payGold - (cost - fromGiven);
  const currentSize = (typeof S.servantBagSize === 'number' && S.servantBagSize > 0) ? S.servantBagSize : 100;
  const newSize = currentSize + 5;
  S.servantBagSize = newSize;
  saveState();
  pushAssetChange(conn);
  log(`[servant] 誓灵背包扩容成功: size=${newSize}（水晶 -${cost}〔赠送 ${fromGiven}〕余 ${S.roleAsset.gold}+${S.roleAsset.gold_given}）`);
  conn.sendToc('m_servant_list_extend_toc', { size: newSize });
},
// 编队 briefs 处理后客户端对 hasDetail=false 的成员逐批拉详情（FormationMgr.dealWithWaitUpdate），
// dealServantDetail 拿详情 initByDetail 后才置 hasDetail 并清等待队列——必须回真实 detail
m_servant_list_detail_tos(conn, obj) {
  const ids = (obj && obj.servant_id_list) || [];
  const seen = new Set();
  const list = [];
  for (const id of ids) {
    const n = Number(id);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const b = S.servants.find(s => s.id === n);
    if (b) list.push(servantDetailOf(b));
  }
  conn.sendToc('m_servant_list_detail_toc', { servant_list: list });
  log(`[servant] 列表详情 ${list.length}/${ids.length}`);
},
// 战斗胜利后客户端 quitFight 会发 m_helper_get_tos（无助战也发）。
// 不回 m_helper_get_toc：空 helper 会让客户端误判"非好友助战"弹 CopyFriendAddPanel →
// getServantConfigVO(nil) 崩。回 m_common_reply_toc：既解除 1 秒网络等待，
// 客户端又对 proto_id=0 静默忽略，不触发 helper 逻辑
m_helper_get_tos(conn) {
  log('[fight] helper_get 抑制（无助战，不弹加好友面板）');
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
// BOSS 战助战选择：CfgCopyDetail 的 BOSS 点（1010103）无 noHelp=1，客户端点开战
// 会走 onOpenHelperPanel 发本协议拉助战列表（原版是好友/陌生人列表）。
// 兜底回空列表 → 面板空白且无法开战。回一个固定"路人助战"：玩家选中后
// CopyHelperItem.onClickBtnFight → toFight(copy_id, role_id) 正常进入 BOSS 战
m_servant_helper_info_tos(conn) {
  conn.sendToc('m_servant_helper_info_toc', {
    list: [{
      role_id: 10001,
      role_name: '御灵士',
      type: 0,              // 陌生人（好友=1）；m_helper_get_tos 已抑制不会触发加好友弹窗
      role_level: 100,
      servant_type: 1331003, // 八岐大蛇（合法 type：面板按它取头像/属性边框，非法 id 会 getServantConfigVO 崩）
      star: 5,
      title: [],
      last_online_ts: Math.floor(Date.now() / 1000),
    }],
  });
  log('[fight] helper_info 回固定助战（BOSS 战选择）');
},
// 学技能：客户端 m_servant_skill_learn_toc 直接 getServant(servant_id).studySkills 插入——
// 兜底回包 servant_id=0 会让 getServant 返回 nil 崩，必须回显请求的 id/技能。
// 同时记入存档 learned_skills（战斗/详情都要下发，否则重登或下次战斗技能丢失）。
//
// 消耗（2026-10-30 二百七十六，此前两样都**从来没扣过**）：
//   ① 银币 = CfgServant[type].skills[].cost（面板「消耗金币：」那一行，ServantSkillDetailPanel
//      lblSliver 显示的就是它；SkillVO.isSliverStudy 拿它和 GlobalData.silver 比）
//   ② 技能模组 = CfgSkillDetail.costItems 按**技能档位 lv** 取件，数量 = **lv 个**
//      （SkillVO.isItemStudy: getStudyLv() <= BagMgr.getItemNum(getStudyCostItem(lv))；
//       面板 lblItem 显示 `持有/lv`，所以"需要 lv 个"不是猜测）
// 客户端 canStudy = 未学 ∧ 等级达标 ∧ 银币够 ∧ 模组够 ∧ 非狂化技 ⇒ 服务端逐条镜像，
// 材料/银币不足回官方码（221001 材料不足 / 1059002 金币不足）并**重推材料包自愈**（D22：
// 客户端门槛纯本地算，一旦两端数量脱钩就永远"面板够、点下去不够"，且不重登不会自愈）。
m_servant_skill_learn_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const skillId = Number((obj && obj.skill_id) || 0);
  const b = S.servants.find(s => s.id === sid);
  const book = b ? (SERVANT_SKILLBOOK[String(b.type)] || SERVANT_SKILLBOOK[b.type] || []) : [];
  const entry = book.find(s => Number(s.id) === skillId);
  const reject = (code, why) => {
    if (code) conn.sendToc('m_common_error_toc', { code });
    else conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // 客户端不插 studySkills，避免与服务端状态脱钩
    log(`[servant] 学习技能拒绝 servant=${sid} skill=${skillId}：${why}`);
  };
  if (!b || !entry || (entry.lv || 0) > (Number(b.level) || 1)) {
    return reject(0, `不在技能书或等级不足（书内 ${book.length} 条，誓灵 Lv${b ? b.level : '-'}）`);
  }
  // 已学（含默认技）：客户端的「学习」按钮本来就不会出现，走到这里只可能是重发/改包——
  // 直接按成功回执（幂等，不能再扣一次材料）而不是拒绝，否则断线重发会白扣一次
  const already = knownSkillIds(b).includes(skillId);
  const lv = Number(entry.lv) || 0;
  const costSilver = Number(entry.cost) || 0;
  const matId = skillLearnItemOf(lv);
  const needMat = lv;                       // 需要 lv 个（客户端 lblItem = 持有/lv）
  const bagNum = t => S.bagGoods.reduce((n, g) => n + (Number(g.type_id) === Number(t) ? Number(g.cur_num) || 0 : 0), 0);
  const haveMat = matId ? bagNum(matId) : 0;
  const haveSilver = Number(S.roleAsset.silver) || 0;
  if (!already) {
    if (costSilver > 0 && haveSilver < costSilver) {
      return reject(1059002, `金币不足（需 ${costSilver}，有 ${haveSilver}）`);
    }
    if (needMat > 0 && haveMat < needMat) {
      resyncMatBags(conn, [matId]);          // 先让客户端背包当场对齐，再回错误码（D22 自愈）
      return reject(221001, `材料不足：${matId} 需 ${needMat} 有 ${haveMat}`);
    }
  }

  // ---- 结算：扣模组（跨格）→ 扣银币 → 记已学 ----
  const updated = [], removed = [];
  let chargedSilver = 0;
  if (!already) {
    if (needMat > 0) {
      let left = needMat;
      for (const g of S.bagGoods) {
        if (left <= 0 || Number(g.type_id) !== matId) continue;
        const take = Math.min(left, Number(g.cur_num) || 0);
        g.cur_num -= take; left -= take;
        (g.cur_num <= 0 ? removed : updated).push(g);
      }
      S.bagGoods = S.bagGoods.filter(g => Number(g.cur_num || 0) > 0);
    }
    if (costSilver > 0) {
      S.roleAsset.silver = Math.max(0, haveSilver - costSilver);
      chargedSilver = costSilver;
    }
  }
  if (!Array.isArray(b.learned_skills)) b.learned_skills = [];
  const isNew = skillId > 0 && !b.learned_skills.includes(skillId);
  if (isNew) b.learned_skills.push(skillId);
  saveState();
  // 推送顺序：材料 → 货币 → 名气 → 回执（回执触发客户端 Tips/音效/引导推进，必须最后）
  if (updated.length) pushGoodsUpdate(conn, updated, 3);
  if (removed.length) pushGoodsUpdate(conn, removed, 2);
  if (chargedSilver > 0) pushAssetChange(conn);
  require('./altar').pushFameUpdates(conn); // 技能数入名气公式，diff 推送
  conn.sendToc('m_servant_skill_learn_toc', {
    servant_id: sid,
    skill: skillId,
  });
  log(`[servant] 学习技能 servant=${sid} skill=${skillId} 已学=[${b.learned_skills.join(',')}]`
    + (already ? '（重复请求，幂等跳过扣费）'
      : ` 扣 ${matId}x${needMat} 银币-${chargedSilver}（余 ${S.roleAsset.silver}）`));
},
// 装备/卸下技能（技能页签核心协议，此前未实现 → Proxy 兜底回 common_reply = "点装备无反应"）：
// skill_id=0 → 卸下 pos 槽（拖出装备栏远端也是它）；skill_id>0 → 装到 pos 槽（须已学：默认技或 learned）。
// team_id>0 = 编队上下文（布阵界面配技）——客户端按回包 team_id 更新编队 VO 的 usingSkills/fightSkills；
// 本地服口径：编队与全局共用同一套装备位（p_team_servant.fight_skill 也从这里下发，两处永远一致）
m_servant_skill_op_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const skillId = Number((obj && obj.skill_id) || 0);
  const pos = Number((obj && obj.pos) || 0);
  const teamId = Number((obj && obj.team_id) || 0);
  const b = S.servants.find(s => s.id === sid);
  if (!b || !(pos >= 1 && pos <= 3)) {
    conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    return;
  }
  const cur = usingSkillsOf(b);
  if (skillId === 0) {
    cur[pos - 1] = 0;
  } else if (knownSkillIds(b).includes(skillId)) {
    for (let i = 0; i < 3; i++) if (cur[i] === skillId) cur[i] = 0; // 同技不重复占槽
    cur[pos - 1] = skillId;
  } else {
    log(`[servant] 技能op拒绝（未学）servant=${sid} skill=${skillId}`);
  }
  b.using_skills = cur;
  saveState();
  conn.sendToc('m_servant_skill_op_toc', { servant_id: sid, using_ids: cur, team_id: teamId });
  log(`[servant] 技能op servant=${sid} ${skillId === 0 ? '卸下' : '装备'} pos=${pos} → [${cur.join(',')}]`);
},
// ---- 训练（吃结晶获取经验升级）----
// 官方流程：客户端 toTrain 发 items=[{id:材料typeId, val:数量}]，服务端扣材料+金币 →
// 推 m_servants_change_toc（exp 先、level 后；客户端记 lastExp/lastLevel 供升级动画）→
// 回 m_servant_train_toc（结果面板读 old_level/level/exp/get_exp，VO 已更新故动画从旧值滚到新值）。
// 材料 CfgItems.data.train（见 data/train_data.js）：exp/cost/nature，同属性材料经验 ×1.5
//
// ⚠️ op_type 是**本次训练的随机结果档位**，不是常量（曾经写死 1，导致每次都显示"150%"）：
//   0 = 成功（100%）/ 1 = 大成功（150%）/ 2 = 超大成功（200%）。
//   客户端 ServantTrainResultView.onGUI 用 lblScale 显示该百分比，onEnd 再按它选标题特效
//   P_ui_sjxsjm1.{a,b,c}{1,2}。倍率与档位必须由**同一次掷骰**派生，否则面板与实得经验对不上。
//   掷骰规则见 train_data.rollTrainTier（官方概率不可考，基线 + 星图 42 加成）。
//
// ⚠️ 限定材料（servantTypeId / servantCamp）必须服务端自己挡：客户端
//   ServantTrainSelectItemPanel.filter 只是"不让选"，改包可绕过。语义取"跳过"而非"拒绝整单"——
//   与客户端一致（不可用材料根本进不了 selectItems），且不会因一个脏 item 吞掉整次训练的其它材料。
m_servant_train_tos(conn, obj) {
  const sid = (obj && obj.servant_id) || 0;
  const items = Array.isArray(obj && obj.items) ? obj.items : [];
  const b = S.servants.find(s => s.id === sid);
  const reply = (oldLevel, level, exp, getExp, opType) => conn.sendToc('m_servant_train_toc', {
    servant_id: sid, old_level: oldLevel, level, exp, get_exp: getExp, op_type: opType,
  });
  if (!b) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; } // 未知 id 不回 toc（客户端 getServant(nil) 会崩），common_reply 只解 loading
  const nature = TRAIN.natureOf(b.type); // 客户端 ServantConfigVO.ctor 同规则（Util.indexNum(type,4,4)）
  let baseExp = 0, costSilver = 0;
  const updated = [], removed = [];
  for (const it of items) {
    const typeId = Number(it && it.id) || 0;
    const num = Math.max(0, Math.floor(Number(it && it.val) || 0));
    const mat = TRAIN.TRAIN_ITEMS[typeId];
    const g = S.bagGoods.find(x => x.type_id === typeId);
    if (!mat || !g || num <= 0) continue;
    // 限定材料校验（雪见大福仅雪女 / 试炼的传承·伪仅奥林匹斯）：不匹配就跳过，不扣不涨
    const ban = TRAIN.trainItemBanReason(mat, b);
    if (ban) { log(`[train] 跳过材料 ${typeId}：${ban}`); continue; }
    const use = Math.min(num, g.cur_num);
    if (use <= 0) continue;
    // 自然结晶（nature=0）的 1.5 倍已做进配置 base exp（150/750/2250），这里不再乘 —— 誓灵 nature 恒 ∈1..8，不会误命中
    const bonus = (mat.nature !== 0 && mat.nature === nature) ? 1.5 : 1;
    baseExp += Math.floor(mat.exp * use * bonus);
    costSilver += mat.cost * use;
    g.cur_num -= use;
    if (g.cur_num <= 0) {
      S.bagGoods.splice(S.bagGoods.indexOf(g), 1);
      removed.push(g);
    } else updated.push(g);
  }
  // 没吃到有效材料：回"成功/0 经验"，档位必须是 0（回 1 会让面板显示 150% 却是 0 经验）
  if (baseExp <= 0) { reply(b.level || 1, b.level || 1, b.exp || 0, 0, 0); return; }
  // 掷档位：星图 42「幸运值UP」只加"大成功"概率（+0.5pp/级，满级 +2.5pp）
  let luckLv = 0;
  try { luckLv = require('./grow').starLv(42); } catch (e) { /* 星图未就绪按 0 算 */ }
  const tier = TRAIN.rollTrainTier(luckLv);
  const getExp = Math.floor(baseExp * tier.mul); // 只在末尾取整一次（材料各自 floor 后不再二次截断）
  // 金币：客户端按钮已校验余额，服务端兜底扣到 0 为止（宽松本地服语义，防负数）
  S.roleAsset.silver = Math.max(0, (S.roleAsset.silver || 0) - costSilver);
  try { require('./act_extra').actEvent(conn, 'train', 1, null); } catch (e) { /* 忽略 */ }
  try { if (costSilver > 0) require('./act_extra').actEvent(conn, 'silver', costSilver, null); } catch (e) { /* 忽略 */ }
  const r = TRAIN.applyServantExp(b, getExp);
  // 满级誓灵吃结晶：溢出经验按转化率存入协会时光银行（二百一十六，与战斗结算同口径）
  if (r.overflow > 0) {
    try { require('./dorm').bankDeposit(r.overflow); } catch (e) { /* 银行异常不阻塞训练 */ }
  }
  saveState();
  // 推送顺序：材料 → 货币 → 誓灵字段 → 训练回执（回执触发结果面板，必须最后）
  if (updated.length) pushGoodsUpdate(conn, updated, 3);
  if (removed.length) pushGoodsUpdate(conn, removed, 2);
  pushAssetChange(conn);
  const changes = [{ servant_id: sid, key: CHANGE_ID_EXP, val: r.exp }];
  if (r.level !== r.oldLevel) changes.push({ servant_id: sid, key: CHANGE_ID_LEVEL, val: r.level });
  pushServantChanges(conn, changes);
  reply(r.oldLevel, r.level, r.exp, r.gained, tier.opType);
  const tierName = ['成功', '大成功', '超大成功'][tier.opType];
  log(`[train] 训练 servant=${sid} type=${b.type} 材料${items.length}种 基础${baseExp} ×${tier.mul}(${tierName}) 折算经验${getExp} 实得+${r.gained} Lv${r.oldLevel}→${r.level} exp=${r.exp} 金币-${costSilver}`
    + ` [大成功率${(tier.bigRate * 100).toFixed(1)}% 星图42 Lv${luckLv}]`);
  // 任务推进：cond 16 =「进行{0}次誓灵训练」（CfgMission.conditionTip[16]）。
  // 上面 actEvent('train') 只走 collab 分支（活动任务 60005/55005），通用任务必须在这里另推；
  // advanceMissions 的通用分支已排除 m.collab，不会与活动任务重复计数。
  try { require('./activity').advanceMissions(conn, { trainCount: 1 }); } catch (e) { /* 任务未就绪不阻塞训练 */ }
},
// ---- 突破（overstep / 界限突破）----
// 等级上限 = 75 + overstep*5（客户端 getMaxLv 同式）→ 0 突 75 级、5 突 100 级、11 突 130 级（满）。
// 两条分支（ServantConfigVO.canOverstep / ServantTrainBreakView.onClickBtnBreak 实证）：
//   ① 前 5 突（overstep 0→5）：客户端在素材选择面板挑 nums[overstep+1] 只誓灵，
//      tos 带 cost_ids → **服务端必须真的吃掉这些誓灵 + 扣金币**。
//      可选素材 = canUse()（status==0 且不在任何编队）且 id≠自己 且（同 typeId 或在 commons 通用素材表里）。
//   ② 界限突破（overstep 5→11）：level>=100 时客户端走确认框，tos **不带 cost_ids**，改吃
//      CfgServant.breakMaterials（技能模组/核心晶组/能量芯片…）。前置 isCanDoOverstepMission =
//      star==5 且 feeling>=100 且 100<=level<130。
// 官方错误码 173001~173013（按 toc protoId=173 编号）本身就是需求文档，逐条照用。
// 回包 {servant_id, cost_ids, overstep}：客户端 setOverstep(overstep) 是绝对赋值；
// **被吃掉的誓灵客户端不会自己删**，必须另推 m_servant_update_toc{del}（与分解同路径）。
m_servant_break_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const costIds = Array.isArray(obj && obj.cost_ids) ? obj.cost_ids.map(Number) : [];
  const b = S.servants.find(s => s.id === sid);
  if (!b) {
    conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // 未知 id 不回 toc（客户端 getServant(nil) 会崩）
    log(`[train] 突破：未知誓灵 id=${sid}`);
    return;
  }
  const err = (code, why) => {
    conn.sendToc('m_common_error_toc', { code });
    log(`[train] 突破被拒（${code}）servant=${sid} type=${b.type} overstep=${b.overstep || 0}：${why}`);
  };
  const step = Number(b.overstep) || 0;      // 当前突破次数
  // ServantConfigVO.color = typeId 第 5 位（从右数）：1 N / 2 R / 3 SR / 4 UR —— breaks 按它取档
  const color = Math.floor(Number(b.type) / 10000) % 10;
  const vo = BK.BREAKS[color] || BK.BREAKS[4];
  if (step >= BK.MAX_OVERSTEP) return err(BK.ERR.FULL, `已突破满 ${BK.MAX_OVERSTEP} 次（上限 Lv${TRAIN.maxLevelOf(b)}）`);
  const cost = vo.costs[step] || 0;           // costs/nums 都按 [overstep+1] 取 → 0-based 下标就是 step
  if ((S.roleAsset.silver || 0) < cost) return err(BK.ERR.NOT_SILVER, `金币不足（需 ${cost}，有 ${S.roleAsset.silver || 0}）`);

  const eaten = [];        // 被吃掉的誓灵 id
  const matSpend = [];     // 被吃掉的材料 {id,num}
  if (step < BK.NORMAL_OVERSTEP) {
    // ---- 前 5 突：吃誓灵 ----
    const needLv = BK.OVER_STEP_LVS[step] != null ? BK.OVER_STEP_LVS[step] : 25;
    if ((Number(b.level) || 1) < needLv) return err(BK.ERR.NEED_LEVEL, `等级不足（需 Lv${needLv}，当前 Lv${b.level}）`);
    const needNum = vo.nums[step] || 0;
    // 去重后逐个校验（客户端不会重复选，但协议层要防）
    const uniq = [...new Set(costIds)].filter(id => id !== sid);
    if (uniq.length < needNum) return err(BK.ERR.COST_NUM, `素材誓灵不足（需 ${needNum} 只，收到 ${uniq.length} 只）`);
    const picked = uniq.slice(0, needNum);
    for (const cid of picked) {
      const f = S.servants.find(s => s.id === cid);
      if (!f) return err(BK.ERR.COST_TYPE, `素材誓灵 ${cid} 不存在`);
      // 同 typeId 或在通用素材表 commons 里（ServantTrainBreakSelectPanel.filter 同口径）
      if (Number(f.type) !== Number(b.type) && !vo.commons.includes(Number(f.type))) {
        return err(BK.ERR.COST_TYPE, `素材誓灵 ${cid}(type ${f.type}) 既非同名也不在通用素材表 [${vo.commons.join(',')}]`);
      }
      // canUse()：status==0 且不在任何编队
      if (Number(f.status) !== 0) return err(BK.ERR.COST_IN_TEAM, `素材誓灵 ${cid} 状态占用（status=${f.status}）`);
      if (servantInAnyTeam(cid)) return err(BK.ERR.COST_IN_TEAM, `素材誓灵 ${cid} 在编队中`);
      eaten.push(cid);
    }
  } else {
    // ---- 界限突破：吃材料 ----
    if (EV.normStar(b.star) < BK.LIMIT_NEED_STAR) return err(BK.ERR.NEED_STAR5, `需进化到 ${BK.LIMIT_NEED_STAR} 星（当前 ${EV.normStar(b.star)} 星）`);
    if ((Number(b.level) || 1) < BK.LIMIT_NEED_LEVEL) return err(BK.ERR.NEED_LV100, `需 Lv${BK.LIMIT_NEED_LEVEL}（当前 Lv${b.level}）`);
    if ((Number(b.feeling) || 0) < BK.LIMIT_NEED_FEELING) return err(BK.ERR.NEED_FEELING, `需羁绊 ${BK.LIMIT_NEED_FEELING}（当前 ${Number(b.feeling) || 0}；去宿舍休息室送礼，或 GM: m21_feeling）`);
    const tier = BK.BREAK_MATERIALS[step - BK.NORMAL_OVERSTEP] || [];
    const bagNum = t => S.bagGoods.reduce((n, g) => n + (Number(g.type_id) === Number(t) ? Number(g.cur_num) || 0 : 0), 0);
    for (const it of tier) {
      if (bagNum(it.id) < it.num) {
        // 先重推材料包：客户端若因历史"扣了没推"而高估持有量，这一步让它当场对齐，
        // 否则玩家只会看到"面板说够、点下去说不够"，且不重登永远对不上（二百六十九）
        resyncMatBags(conn, tier.map(x => x.id));
        return err(BK.ERR.NOT_MATERIAL, `材料不足：${BK.MAT_NAMES[String(it.id)] || it.id} 需 ${it.num} 有 ${bagNum(it.id)}`);
      }
      matSpend.push({ id: it.id, num: it.num });
    }
  }

  // ---- 结算 ----
  const updated = [], removed = [];
  for (const s of matSpend) {
    let left = s.num;
    for (const g of S.bagGoods) {
      if (left <= 0 || Number(g.type_id) !== s.id) continue;
      const take = Math.min(left, Number(g.cur_num) || 0);
      g.cur_num -= take; left -= take;
      (g.cur_num <= 0 ? removed : updated).push(g);
    }
  }
  if (matSpend.length) S.bagGoods = S.bagGoods.filter(g => Number(g.cur_num || 0) > 0);
  if (eaten.length) {
    S.servants = S.servants.filter(s => !eaten.includes(s.id));
    // 素材誓灵可能在别的编队替补/爬塔队/探索队/看板娘组里 → 引用统一清掉，否则下发悬空 id
    scrubServantRefs(eaten);
  }
  S.roleAsset.silver = Math.max(0, (S.roleAsset.silver || 0) - cost);
  b.overstep = step + 1;
  saveState();
  // 推送顺序：材料/删誓灵 → 货币 → overstep 字段 → 突破回执（回执触发结果面板，必须最后）
  if (updated.length) pushGoodsUpdate(conn, updated, 3);
  if (removed.length) pushGoodsUpdate(conn, removed, 2);
  if (eaten.length) conn.sendToc('m_servant_update_toc', { new: [], update: [], del: eaten, reward_type: 0 });
  pushAssetChange(conn);
  pushServantChanges(conn, [{ servant_id: sid, key: CHANGE_ID_OVERSTEP, val: b.overstep }]);
  try { require('./altar').pushFameUpdates(conn); } catch (e) { /* 名气推送失败不阻塞突破 */ }
  conn.sendToc('m_servant_break_toc', { servant_id: sid, cost_ids: eaten, overstep: b.overstep });
  log(`[train] 突破 servant=${sid} type=${b.type}(色${color}) ${step}→${b.overstep} 突 上限Lv=${TRAIN.maxLevelOf(b)}`
    + ` 金币-${cost}`
    + (eaten.length ? ` 吃誓灵 [${eaten.join(',')}]（剩 ${S.servants.length} 只）` : '')
    + (matSpend.length ? ` 吃材料 ${matSpend.map(s => `${BK.MAT_NAMES[String(s.id)] || s.id}x${s.num}`).join(' ')}` : ''));
  const { advanceMissions } = require('./activity'); // 延迟 require：任务推进（cond=17 突破）
  advanceMissions(conn, { breakCount: 1 });
},
// 界限突破的材料需求查询。**这条不实现会让 5 突（Lv100 上限）之后打不开角色详情页**：
// ServantInfoPanel.updateInfo 在 `overstep >= 5 && !hasBreakSpecialMat(id)` 时发本协议，
// toc handler 走 ServantTrainMgr.updateSpecialMatDic(toc) → `ServantMgr.getServant(toc.servant_id).typeId`。
// 兜底 defaultFill 回的是 servant_id=0 → getServant(0)=nil → **"attempt to index a nil value"**。
// 所以必须回显真实 servant_id。
// items 恒发空数组：schema 里它是 `array of "pkvi"`，而 **Proto 里根本没有 pkvi 这个定义**
//（p_kvi 才有，官方表笔误），客户端同一份表也解不出元素 → 发非空元素会解成 nil 再崩在 `slot6.val` 上。
// 真正的材料需求客户端自己从 CfgServant.breakMaterials 取（ServantConfig.getBreakMat），无需服务端下发。
m_servant_break_item_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const b = S.servants.find(s => s.id === sid);
  if (!b) {
    conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // 回显未知 id 同样会崩，只解网络等待
    log(`[train] break_item：未知誓灵 id=${sid}`);
    return;
  }
  conn.sendToc('m_servant_break_item_toc', { servant_id: sid, items: [] });
  const tier = BK.BREAK_MATERIALS[(Number(b.overstep) || 0) - BK.NORMAL_OVERSTEP] || [];
  log(`[train] 界限突破材料查询 servant=${sid} overstep=${b.overstep} → 客户端按配置要 `
    + (tier.map(it => `${BK.MAT_NAMES[String(it.id)] || it.id}x${it.num}`).join(' ') || '（无，已满）'));
},

// ---- 进化（升星）----
// 客户端把配置和表现全包了：CfgServant.starItems 给金币+材料需求、ServantUtil.getStarLv 给等级门槛、
// ServantConfigVO.canEvolution 决定按钮亮不亮，toc handler 自己 `star = star + 1` 再开结果面板。
// tos 只带 servant_id ⇒ 服务端职责 = 校验 → 扣料 → 改 star，回包只回显 servant_id。
// 关键：**不能推 m_servants_change_toc(key=4 star)**——客户端 toc handler 已经本地 +1，
// 再收一个绝对值会被叠成 star+2（change 的语义是 `vo[field] = val` 直接赋值）。
// 官方错误码（CfgErrorCode，按 toc protoId=154 编号）：154001 已达到最大星数 / 154002 誓灵等级不够。
// 材料/金币不足官方没给 154003（客户端按钮本来就是灰的），只有服务端/客户端不同步才会走到 →
// 借通用码 221001「材料不足」/ 1059002「金币不足」把原因显式告诉玩家。
m_servant_evolution_upgrade_tos(conn, obj) {
  const sid = Number((obj && obj.servant_id) || 0);
  const b = S.servants.find(s => s.id === sid);
  if (!b) {
    log(`[evolution] 未知誓灵 id=${sid}`);
    conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // 回显未知 id 会让客户端 getServant(nil).star 崩
    return;
  }
  const before = EV.normStar(b.star);
  const bagNum = typeId => {
    let n = 0;
    for (const g of S.bagGoods) if (Number(g.type_id) === Number(typeId)) n += Number(g.cur_num) || 0;
    return n;
  };
  const plan = EV.evaluate({ type: b.type, star: before, level: b.level }, bagNum, S.roleAsset.silver);
  if (!plan.ok) {
    const CODE = { MAX_STAR: 154001, NEED_LEVEL: 154002, NOT_MATERIAL: 221001, NOT_SILVER: 1059002 };
    const code = CODE[plan.reason] || 154001;
    // 材料不足同样是"客户端本地算、服务端只回错误码"的形状 → 顺手把材料包重推一遍
    if (plan.reason === 'NOT_MATERIAL') resyncMatBags(conn, (plan.spend || []).map(s => s.id).concat(plan.lack ? [plan.lack.id] : []));
    conn.sendToc('m_common_error_toc', { code });
    log(`[evolution] 拒绝（${code} ${plan.reason}）servant=${sid} type=${b.type} star=${before} lv=${b.level}`
      + (plan.needLevel ? ` 需Lv${plan.needLevel}` : '')
      + (plan.lack ? ` 缺 ${EV.matName(plan.lack.id)}x${plan.lack.num}` : ''));
    return;
  }
  // 扣料：按 type_id 跨格扣（材料可能分散在多格），扣空的格子移除并推 DEL
  const updated = [], removed = [];
  for (const s of plan.spend) {
    let left = s.num;
    for (const g of S.bagGoods) {
      if (left <= 0 || Number(g.type_id) !== s.id) continue;
      const take = Math.min(left, Number(g.cur_num) || 0);
      g.cur_num -= take;
      left -= take;
      (g.cur_num <= 0 ? removed : updated).push(g);
    }
  }
  S.bagGoods = S.bagGoods.filter(g => Number(g.cur_num || 0) > 0);
  S.roleAsset.silver = Math.max(0, (S.roleAsset.silver || 0) - plan.cost);
  b.star = plan.next;
  // 进化 = 外观随星级进阶：当前穿的是本类型普通皮（初始/旧档进化皮，getWayID 0/3/4/5）时
  // 自动换到新星级的进化皮（CfgServantSkin.getWayID == 新 star；该星无进化皮则保持）。
  // 付费/活动皮（actItemID>0）不自动覆盖。客户端 evolution toc handler 会把 skin VO 标
  // dataIsOK=false → 下次皮肤查询回新 cur_skin → updateCurrSkinVO 写 VO.skinID，
  // 协会/备战立绘即随新形态；战斗 enter_list 的 skin_id 同源（fightServantOf）。
  const skins = SKIN_CFG.types[b.type] || [];
  const curEntry = skins.find(s => s.skinID === Number(b.skin_id));
  if (curEntry && curEntry.actItemID === 0 && [0, 3, 4, 5].includes(curEntry.getWayID)) {
    const nextSkin = skins.find(s => s.actItemID === 0 && s.getWayID === plan.next);
    if (nextSkin) b.skin_id = nextSkin.skinID;
  }
  saveState();
  // 推送顺序：材料 → 货币 → 进化回执（回执触发客户端 star+1 与结果面板，必须最后）
  if (updated.length) pushGoodsUpdate(conn, updated, 3);
  if (removed.length) pushGoodsUpdate(conn, removed, 2);
  pushAssetChange(conn);
  // 名气（誓灵培养面快照）含星级；进化后重算并 diff 推送
  try { require('./altar').pushFameUpdates(conn); } catch (e) { /* 名气推送失败不阻塞进化 */ }
  // 图鉴条目的 star = 该类型最高星（进化皮肤按 getStep(star) 选图），重推红点/列表由客户端下次拉取
  conn.sendToc('m_servant_evolution_upgrade_toc', { servant_id: sid });
  log(`[evolution] 进化 servant=${sid} type=${b.type} ${before}★→${plan.next}★ 金币-${plan.cost} 材料 `
    + plan.spend.map(s => `${EV.matName(s.id)}x${s.num}${s.replaceFor ? `(替代${EV.matName(s.replaceFor)})` : ''}`).join(' ')
    + ` → 种族值档位 step${FC.stepOfStar(before)}→${FC.stepOfStar(plan.next)}`);
},
// ---- 皮肤 ----
// 皮肤面板（角色详情→皮肤）：checkServantSkinVO 无数据就发本协议。
// 兜底回包 servant_id=0 → setCurrSkinInfo 标记到 0 号 VO，真誓灵的 VO 永远 dataIsOK=false，
// 面板每帧重发（实测日志轮询 3.5 万次）且所有皮肤显示未激活。必须回显 servant_id。
m_servant_skin_tos(conn, obj) {
  const sid = (obj && obj.servant_id) || 0;
  const b = S.servants.find(s => s.id === sid);
  conn.sendToc('m_servant_skin_toc', skinTocPayload(b, sid));
},
// GM 免费商店（调试面板→商店→皮肤）：goods_id 为 CfgItems 道具 ID（22001xxx 解锁皮肤道具）。
// 回显 toc 解除网络等待；若映射到皮肤则入档并推 m_servant_shop_active_skin_toc——
// 客户端 addNewOwnSkinID 更新皮肤 VO（面板立即变"已激活"）+ 弹新皮肤获得面板
m_role_freeshop_get_goods_tos(conn, obj) {
  const goodsId = Number((obj && obj.goods_id) || 0);
  const num = Number((obj && obj.num) || 1);
  conn.sendToc('m_role_freeshop_get_goods_toc', { goods_id: goodsId, num });
  const skinId = SKIN_CFG.itemToSkin[goodsId];
  if (skinId) {
    if (!S.skinState.owned.includes(skinId)) S.skinState.owned.push(skinId);
    if (!S.skinState.l2dOwned) S.skinState.l2dOwned = [];
    const hasLive2d = (SKIN_CFG.live2dSkins || []).includes(skinId) ? 1 : 0;
    if (hasLive2d && !S.skinState.l2dOwned.includes(skinId)) S.skinState.l2dOwned.push(skinId);
    saveState();
    // 新皮肤 → 皮肤图鉴红点/is_new（延迟 require 解循环依赖）
    const hb = require('./handbook');
    if (hb.onSkinObtained(skinId)) { saveState(); hb.pushSkinRedPoints(conn); }
    // gain_live：皮肤在 live2dSkins 列表时回 1（拥有 Live2D，不自动开启本地开关）。
    // 回 0 会把客户端 updateHasOwnLive2d 缓存写成 false，覆盖 state 查询结果 → 开关失灵
    conn.sendToc('m_servant_shop_active_skin_toc', {
      skin_type_id: skinId,
      gain_live: hasLive2d,
      gain_servant: 0,  // 已拥有该誓灵（1/2 会当"誓灵未拥有"处理）
    });
    log(`[skin] GM 免费商店解锁皮肤 item=${goodsId} skin=${skinId}`);
  } else {
    // 非皮肤道具：入背包（圣器/核心按实例发放，其余堆叠；CfgItems 无配置的跳过防客户端 getItemVO 崩）
    if (VALID_ITEM_TYPES.has(goodsId)) {
      const changed = grantGoods(goodsId, num, conn);
      saveState();
      pushGoodsUpdate(conn, changed, 3);
      log(`[GM] 免费商店获得物品 item=${goodsId} num=${num}（背包共 ${S.bagGoods.length} 项）`);
    } else {
      log(`[GM] 免费商店物品 item=${goodsId} num=${num}（CfgItems 无配置，跳过入包）`);
    }
  }
},
// 换装（皮肤面板点已拥有皮肤的"换装"）：回显后客户端 updateCurrSkinVO 更新 VO 与誓灵 skin_id
m_servant_change_skin_tos(conn, obj) {
  const sid = (obj && obj.servant_id) || 0;
  const skin = Number((obj && obj.skin_type_id) || 0);
  const op = (obj && obj.op_type) == null ? 1 : obj.op_type;
  const b = S.servants.find(s => s.id === sid);
  let ok = false;
  if (b) {
    const entry = (SKIN_CFG.types[b.type] || []).find(s => s.skinID === skin);
    // 进化皮（getWayID 3/4/5）必须星级达标才允许换上——否则未进化就能穿高阶立绘，
    // 与 m_servant_skin_toc 下发的 com_skin 口径脱钩；
    // 灵契皮（actItemID==1）按"该 type 已缔结"派生放行，与 priv_skin 下发口径同源
    const starOk = !entry || entry.getWayID < 3 || entry.getWayID > 5 || EV.normStar(b.star) >= entry.getWayID;
    const marryOk = !!(entry && entry.actItemID === 1 && L.isTypeMarried(b.type));
    if (entry && starOk && (entry.actItemID === 0 || S.skinState.owned.includes(skin) || marryOk)) {
      b.skin_id = skin;
      saveState();
      ok = true;
    }
  }
  conn.sendToc('m_servant_change_skin_toc', { servant_id: sid, skin_type_id: skin, op_type: op });
  log(ok ? `[skin] 换装 servant=${sid} skin=${skin}` : `[skin] 换装被拒（皮肤不属于该誓灵或未激活）servant=${sid} skin=${skin}`);
},
// 按类型换装（新皮肤获得面板"换上看看"）：更新该类型全部誓灵的当前皮肤
m_servant_type_change_skin_tos(conn, obj) {
  const typeId = Number((obj && obj.servant_type_id) || 0);
  const skin = Number((obj && obj.skin_type_id) || 0);
  let n = 0;
  S.servants.forEach(s => { if (s.type === typeId) { s.skin_id = skin; n++; } });
  if (n) saveState();
  conn.sendToc('m_servant_type_change_skin_toc', { servant_type_id: typeId, skin_type_id: skin });
  log(`[skin] 按类型换装 type=${typeId} skin=${skin}（${n} 只誓灵）`);
},
// Live2D 状态查询：客户端 updateHasOwnLive2d(id, state==1 or state==3) 写入"拥有 Live2D"缓存，
// 之后 isRealShowLive2d = 拥有缓存 and 本地开关设置——开关/立绘切换全依赖它。
// 18 款初始/突破形态默认拥有 Live2D；付费/活动皮肤在 l2dOwned 中拥有时回 state=1，否则回 0
m_skin_live_state_tos(conn, obj) {
  const skinId = Number((obj && obj.id) || 0);
  const isDefaultL2D = [
    103300401, 103300402, 103300403, 103300404,
    133100301, 133100302, 133100303, 133100304,
    143200301, 143200302, 143200303, 143200304,
    153400301, 153400302, 153400303, 153400304,
    354100201, 354100204
  ].includes(skinId);
  const isL2DOwned = isDefaultL2D || ((S.skinState && S.skinState.l2dOwned && S.skinState.l2dOwned.includes(skinId)) ? true : false);
  conn.sendToc('m_skin_live_state_toc', { id: skinId, state: isL2DOwned ? 1 : 0 });
},
// 编队：detail 客户端按单对象访问（updateFormationInfo 直接用 slot0.index 作 table key）
// 按请求 index 回一个空编队；保存（m_role_servant_formation_tos）存内存并回显
m_servant_formation_info_tos(conn, obj) {
  const idx = obj.index == null ? 1 : obj.index;
  conn.sendToc('m_servant_formation_info_toc', { detail: buildFormation(idx, S.formations[idx]) });
},
// 编队 briefs：客户端会遍历组内全部编队（getTeamId/getStateTip 对每支 getFormation(i):hasServant），
// 缺号的编队 getFormation 返回 nil 直接崩——必须 4 支全量下发
//
// ⚠️ 时序不变式（真机 2026-09-12 02:28 崩溃实证）：客户端 VO 的 attr 字段只有一个来源——
// updateFormationInfo 对 briefs[].servants 逐只 initByFormation(p_team_servant)，且仅当
// ServantMgr.getServant(id) 已存在时执行；而创建 VO 的 m_servants_brief_toc 在登录链里
// 比 detail 晚 300ms 推。实测客户端进游戏 ~160ms 就发本请求，若按请求即答，客户端会在
// VO 尚不存在时处理 briefs → initByFormation 全部静默跳过 → VO.attr 永久 nil →
// 之后曜日/活动副本点"进入"，客户端 m_team_template_select_tos 预检 FormationVO:isAllDie
// 取 slot6.attr.hp 报 "attempt to index field 'attr' (a nil value)"（主线因流程先开
// 布阵面板重跑 updateFormationInfo 被顺带掩盖，曜日是首个暴露口）。
// 故应答必须保证 servants brief 先于本包到达：登录定时器（300ms）尚未发过就延后应答；
// 应答时兜底补推（标志位防登录链重复推）。
m_servant_formation_briefs_tos(conn) {
  const send = () => {
    if (!conn.servantsBriefSent) pushServantsBrief(conn);
    sendFormationBriefs(conn);
  };
  // 编队页是首个看板娘依赖请求；不要再把它挂到 400ms 定时器后面。
  // 若登录快照尚未到达，当前请求先直接建立完整誓灵 VO，再发编队数据。
  send();
},
// ---- 新式编队模板（NewFormation，CfgFormation.formationInfo 组 2~15）----
// 2026-10-12 注册（此前未实现 → fallback defaultFill 空 groups，重登后客户端 FormationMgr
// 拿不到编队模板数据）。客户端 onEnterGame 发 m_team_template_info_tos，updateNewFormationInfo 消费：
//   groups[]  : {team_group_id, name, teams[]} —— team_group_id = CfgFormation.formationInfo.id
//               （2=自由编队1(501-504) 3=自由编队2(511-514) 4=自由编队3(521-524) 5=自由编队4(531-534)
//                6~13=唤灵殿堂(551-558) 14~15=信仰对决(559-560)）；teams[] 元素 = p_formation，
//               index 用组内全局编队号（501…），复用 buildFormation 读 S.formations 同一份数据。
//   mapping[] : {copy_type, copy_key, last_id} —— 各副本类型的队伍记忆。客户端
//               setFormationByCopyInfo(copy_type, last_id, copy_key) → CopyMgr.setTeamIndex 回填
//               "上次用的队伍"。服务端唯一的持久记忆是 collab.js 的 S.collabState.selTeam
//               （copyType/teamKey → team_id），按其原样回填；无记录的 copy_type 不下发条目
//               （客户端 getFormationByCopyInfo 查无 mapping 时走默认分支，与旧行为一致）。
// 组名：客户端 updateNewFormationGroupList 对空名回落 NEW_FORMATION_GROUP_NAME 常量，服务端存档
// 未记组名（改名协议 m_team_template_group_name_tos 未实现）→ name 统一空串。
// groups 里组 1 不下发（客户端 updateNewFormationGroupList 对 id==1 直接 return，主线 1~4 号编队
// 走的是老 m_servant_formation_briefs_toc 链，不在本协议管辖）。
m_team_template_info_tos(conn) {
  // 组定义（CfgFormation.formationInfo）：组id → 该组 formationIdList（=S.formations 的编队号）
  const GROUPS = [
    { id: 2,  ids: [501, 502, 503, 504] },
    { id: 3,  ids: [511, 512, 513, 514] },
    { id: 4,  ids: [521, 522, 523, 524] },
    { id: 5,  ids: [531, 532, 533, 534] },
    { id: 6,  ids: [551] }, { id: 7, ids: [552] }, { id: 8, ids: [553] }, { id: 9, ids: [554] },
    { id: 10, ids: [555] }, { id: 11, ids: [556] }, { id: 12, ids: [557] }, { id: 13, ids: [558] },
    { id: 14, ids: [559] }, { id: 15, ids: [560] },
  ];
  const groups = GROUPS.map(g => ({
    team_group_id: g.id,
    name: '',
    teams: g.ids.map(idx => buildFormation(idx, S.formations[idx])),
  }));
  // mapping：collab.selTeam 记忆（{copyType或'def' → team_id}）；copy_key 无法还原（selTeam 键
  // 只有 copy_type），回 0——客户端 setFormationByCopyInfo 的 copy_key=0 走 getFormationByCopyKey
  // 默认键，与选择时同源。
  const mapping = [];
  const selTeam = (S.collabState && S.collabState.selTeam) || {};
  for (const key of Object.keys(selTeam)) {
    const teamId = Number(selTeam[key]) || 0;
    if (teamId <= 0) continue;
    if (key === 'def') continue; // 无类型记忆不回填（客户端按默认队伍）
    mapping.push({ copy_type: Number(key), copy_key: 0, last_id: teamId });
  }
  // 重连自愈（二百七十五：重连被当冷启动，客户端会重发登录 tos，但 Lua 态不重载——
  // 客户端 onEnterGame 重发 info_tos 后 updateNewFormationInfo 会 setNowTeamList(回包值)
  // 并重建全部新编队 VO（status 洗回 0））。mapState 带 locked 标记（init_barrier 打标；
  // daily/dare/collab 结算后故意残留的会话没有）时回真实值并在包尾补推 status=1，
  // 冷登录（无会话）维持 0/[]/0 与现状零差异。
  const msLock = S.mapState;
  const liveLock = !!(msLock && msLock.locked && (msLock.use_team_ids || []).some(id => Number(id) > 0));
  const lockIds = liveLock ? [...new Set((msLock.use_team_ids || []).map(Number))].filter(id => id > 0) : [];
  conn.sendToc('m_team_template_info_toc', {
    groups: groups,
    mapping: mapping,
    barrier_id: liveLock ? (msLock.barrierId || 0) : 0,
    use_team_ids: lockIds,
    last_id: liveLock ? (msLock.lastId || 1) : 0,
  });
  if (lockIds.length) {
    conn.sendToc('m_team_update_status_toc', { updates: lockIds.map(id => ({ id, val: 1 })) });
  }
  log(`[formation] 推送编队模板 ${groups.length} 组 / mapping ${mapping.length} 条`
    + (liveLock ? `（存活会话 barrier=${msLock.barrierId} 补锁 [${lockIds.join(',')}]）` : ''));
},
// 单成员上下阵（编队界面拖入/点击选择）：客户端 toChangeFormation 发出后
// 等 m_servant_formation_info_toc（detail）推送刷新界面（无独立 toc）
m_team_formation_change_tos(conn, obj) {
  const teamId = obj.team_id || 1;
  const nth = obj.nth || 0;      // 客户端语义：1-3 主力位，4-6 备战位（BaseFormationItem.switchTeamMember 备战 +3）
  const sid = obj.servant_id || 0;
  const f = S.formations[teamId] = S.formations[teamId] || {};
  let field = normSlots(f.field);
  let bench = normSlots(f.bench);

  if (sid > 0 && nth >= 1 && nth <= 6) {
    // 记录 sid 当前位置（交换回填用）
    let from = 0;
    field.forEach((id, i) => { if (id === sid) from = i + 1; });
    if (!from) bench.forEach((id, j) => { if (id === sid) from = j + 4; });

    const isMainSlot = nth <= 3;
    const nthIdx = isMainSlot ? nth - 1 : nth - 4;
    const occupied = (isMainSlot ? field[nthIdx] : bench[nthIdx]) || 0; // 目标位上的誓灵

    // 先移除 sid（不可重复上阵）
    field = field.map(id => id === sid ? 0 : id);
    bench = bench.map(id => id === sid ? 0 : id);
    // 注意：map 生成了新数组，必须重新通过 field/bench 变量写入（不能缓存旧数组引用）
    if (isMainSlot) field[nthIdx] = sid;
    else bench[nthIdx] = sid;

    // 双向交换：被挤下的誓灵回填到 sid 腾出的位置
    if (occupied > 0 && occupied !== sid) {
      if (from) {
        if (from <= 3) field[from - 1] = occupied;
        else bench[from - 4] = occupied;
      } else {
        // sid 原不在编队（如从列表加入），被挤者进备战空位
        const empty = bench.findIndex(id => !id);
        if (empty >= 0) bench[empty] = occupied;
      }
    }
  } else if (sid > 0) {
    // nth 无效：下阵处理
    field = field.map(id => id === sid ? 0 : id);
    bench = bench.map(id => id === sid ? 0 : id);
  } else if (nth >= 1 && nth <= 3) {
    field[nth - 1] = 0; // 下阵
  }

  f.field = field;
  f.bench = bench;
  // 同步 p_team_servant 数组（field 上阵 is_field=1，替补 0）
  f.servants = field.filter(id => id > 0).map(id => teamServantOf(id, 1, teamId))
    .concat(bench.filter(id => id > 0).map(id => teamServantOf(id, 0, teamId)))
    .filter(Boolean);
  // 同组移动语义（149006 族，二百八十二·续 F）：客户端跨队选人先弹"是否将 X 从队伍A 更换至
  // 队伍B"确认框（FormationSelectPanel.replaceServantToTeam）再发本协议——sid 若在同组其他队，
  // 这里从旧队移除（官方=移动），被移除队在下方补推编队数据刷新面板。
  const movedFrom = sid > 0 ? stripServantFromSameGroup(sid, teamId) : [];
  const changedIds = syncServantTeamIds();
  saveState();
  log(`[formation] 变更 team=${teamId} nth=${nth} servant=${sid} field=[${field}] bench=[${bench}]`);
  conn.sendToc('m_servant_formation_info_toc', { detail: buildFormation(teamId, f) });
  // 编队面板拖拽交换/选人走本协议，但引导组11/12 步进的完成事件 UPDATE_FORMATION_INFO
  // 全客户端只在 m_role_servant_formation_toc 回包处理里派发（FormationModule_ljd 一处），
  // info_toc 的处理不派发 → 只回 info_toc 时"拖动交换誓灵"引导永远不完成
  // （真机 2026-09-05 实证：拖动生效、引导卡住）。补推整体保存回包：
  // 客户端幂等重放同一 detail（updateFormationInfo + updatePanel）并派发
  // UPDATE_FORMATION_INFO / ON_MAP_TEAM_UPDATE / UPDATE_TEAM_PLAN_INFO 三个事件，
  // 编队面板与助战/副本计划等监听方均为刷新类副作用，安全。
  conn.sendToc('m_role_servant_formation_toc', { detail: buildFormation(teamId, f) });
  // 被移除的旧队补推编队数据（客户端 m_servant_formation_info_toc → updateFormationInfo+updatePanel）
  for (const ridx of movedFrom) {
    conn.sendToc('m_servant_formation_info_toc', { detail: buildFormation(ridx, S.formations[ridx]) });
  }
  pushServantsTeamChanges(conn, changedIds);
},
m_role_servant_formation_tos(conn, obj) {
  const idx = obj.index == null ? 1 : obj.index;
  // 合并保存：拖拽提交（toFormation）不带 lineup，整体覆盖会丢掉已换的阵型
  const old = S.formations[idx] || {};
  S.formations[idx] = Object.assign({}, old, obj);
  // 同组移动语义自愈（二百八十二·续 F）：拖拽只在本队内移动，同组他队若仍挂着同 id
  //（改包/历史脏数据）一并移除，保持组内一灵一队；被移除队在下方补推编队数据。
  const movedFrom = [];
  {
    const nf = normSlots(S.formations[idx].field), nb = normSlots(S.formations[idx].bench);
    for (const sid of new Set([].concat(nf, nb).filter(id => Number(id) > 0).map(Number))) {
      for (const ridx of stripServantFromSameGroup(sid, idx)) {
        if (!movedFrom.includes(ridx)) movedFrom.push(ridx);
      }
    }
  }
  const changedIds = syncServantTeamIds();
  saveState();
  // detail 按单对象下发（客户端 updateFormationInfo(slot0.detail) 直接取 .index）
  conn.sendToc('m_role_servant_formation_toc', { detail: buildFormation(idx, S.formations[idx]) });
  for (const ridx of movedFrom) {
    conn.sendToc('m_servant_formation_info_toc', { detail: buildFormation(ridx, S.formations[ridx]) });
  }
  pushServantsTeamChanges(conn, changedIds);
},
// 布阵面板换阵型：客户端 toPos 提交新 positions（映射到新阵型的格子）+ lineup
m_role_servant_position_tos(conn, obj) {
  const idx = obj.index == null ? 1 : obj.index;
  const f = S.formations[idx] || (S.formations[idx] = {});
  // 换阵型校验解锁：未解锁的阵型不接受（客户端 checkCanSelect 已拦，这里防脏数据/旧包）；
  // 被拒时连 positions 一起丢弃（客户端的站位是按被拒阵型映射的，保留会与生效阵型的启用格错位）。
  // lineup=0 是纯拖拽调位（toPos 第三参可空）：不换阵型，保留客户端站位
  const unlocked = unlockedLineups();
  const wantLineup = Number(obj.lineup) || 0;
  const cur = Number(f.lineup) || 1;
  const lineup = wantLineup && unlocked.includes(wantLineup) ? wantLineup : (unlocked.includes(cur) ? cur : 1);
  const posList = (wantLineup === 0 || wantLineup === lineup) ? (obj.brief_pos_list || []).map(Number).filter(n => n >= 1 && n <= 6) : [];
  f.positions = posList.length ? posList : (LINEUP_POS[lineup] || LINEUP_POS[1]);
  f.lineup = lineup;
  saveState();
  log(`[formation] 换阵型 team=${idx} lineup=${f.lineup} positions=[${f.positions}]`);
  conn.sendToc('m_role_servant_position_toc', {
    index: idx,
    brief_pos_list: f.positions,
    lineup: f.lineup || 1,
  });
},
// 阵型列表：布阵面板首次打开时客户端主动拉取（ServantLineupView.initLineupView → hasLineUpData 判空）
m_servant_lineup_info_tos(conn) {
  pushLineupInfo(conn);
},
// 点掉新解锁阵型的 new 角标（客户端本地已 delLineupNew，服务端只做持久化）；
// 无同名 toc schema，回 m_common_reply_toc 重置网络等待计时器
m_servant_lineup_touch_tos(conn, obj) {
  const id = Number((obj && obj.lineup) || 0);
  const st = S.lineupState || (S.lineupState = {});
  if (unlockedLineups().includes(id) && !(st.touched || []).includes(id)) {
    (st.touched || (st.touched = [])).push(id);
    saveState();
    log(`[lineup] touch 阵型 ${id}（消 new 标记）`);
  }
  conn.sendToc('m_common_reply_toc', { proto_id: 0 });
},
// ---- 能源（强化第 4 页签）----
// 加点：num = 该属性的目标点数（绝对值）。客户端两条路径：能源页签拖进度条
// onValueChange 发 floor(条值)=新绝对点数；点属性图标弹的 AllotEnergyPanel 发增量——
// 以主交互（拖条）的绝对值语义为准。校验：单属性不超 ceil、总和不超过池 32，
// 越界钳到合法值（客户端本地也限，双保险防脱同步）。
// 回 toc 的 point 也是绝对值（客户端 setEnergyPoint 直接赋值）。
m_servant_energy_alloc_tos(conn, obj) {
  const b = S.servants.find(s => s.id === (obj && obj.servant_id));
  if (!b) { log('[energy] alloc 未知誓灵', obj && obj.servant_id); conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const prop = Number((obj && obj.prop_code) || 0);
  if (!ED.ENERGY_PROPS.includes(prop)) { log(`[energy] alloc 非法属性 ${prop}`); conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const ceil = Number((b.energy_ceils || {})[prop]) || 0;
  const old = Number((b.energy_points || {})[prop]) || 0;
  const want = Math.max(0, Math.floor(Number((obj && obj.num) || 0)));
  // 池约束：32 - (当前总和 - 本属性旧值) ≥ 0 → 目标点最多到 remain + old
  const remain = ED.ENERGY_TOTAL - energySum(b) + old;
  const point = Math.min(want, ceil, remain);
  // ⚠️ 幂等短路（2026-10-17 azhi 真机能源滑块 0↔15 自激风暴）：
  // 客户端 ServantEnergyView.onUpdateMainView **程序写 pbCur.value 同样触发 onValueChange**
  // （CProgressBar.Awake 把 Slider.onValueChanged 无条件转发给 Lua），后者 0.1s 后必发
  // energy_alloc_tos。面板每次刷新都可能"把当前值再报一遍"，若服务端照单全收并回包，
  // 回包又触发一次刷新 → 每秒 2 次 tos/toc 死循环，且每轮 saveState 在 Android 外存上
  // 耗时 500~950ms，直接表现为"隔几秒顿一下"。
  // 契约：**请求值 === 当前值** = 客户端只是回显/重放，不是玩家操作 → 不回包、不写盘、不推名气。
  // 注意必须用 want 而不是 point 判定：请求被 ceil/池钳制回当前值时（want≠old, point==old），
  // 客户端 UI 还停在 want 上，必须回包纠正，否则显示与存档不一致。
  // （不回 toc 安全：客户端 handler 只做 setEnergyPoint 幂等赋值，不依赖回包推进状态机）
  if (want === old) {
    log(`[energy] alloc 幂等跳过 servant=${b.id} prop=${prop} point=${point}（客户端回显，不写盘不回包）`);
    // "不回包"指的是**不回 m_servant_energy_alloc_toc**（回它会喂回 UI 造成 0↔15 自激风暴，D8）。
    // 但连着拖滑块时这里若一个字节都不发，客户端 3 秒必弹「服务端未响应」（2026-10-24 平板实测
    // 一次拖动 31 条 alloc、其中 6 条走本分支）。game_server.js 的 ensureReplied() 会自动补
    // m_common_reply_toc（客户端完全忽略、不碰能源 UI，不会再进循环）——这里保持 return 即可。
    return;
  }
  if (!b.energy_points) b.energy_points = {};
  b.energy_points[prop] = point;
  // 高频操作（滑块拖动）用 defer 合并写盘：50ms 内的连续 alloc 只落盘一次。
  // 不改变最终状态（flushSave 在退出/切号时强制落盘），只削掉逐次 fsync。
  if (point !== old) saveState({ defer: true, delay: 50 });
  log(`[energy] 加点 servant=${b.id} prop=${prop} ${old}->${point}（剩 ${ED.ENERGY_TOTAL - energySum(b)}）`);
  require('./altar').pushFameUpdates(conn); // 能源点数入名气公式，diff 推送
  // team_id 回 0：客户端 toc 优先更新编队 VO（getNewFormationServantVO），回显请求的
  // 编队号会让 ServantMgr 主 VO 不刷新、面板下一次 onUpdateMainView 读到旧值
  conn.sendToc('m_servant_energy_alloc_toc', { servant_id: b.id, prop_code: prop, point, team_id: 0 });
},
// 重置：清空全部已分配点数（上限保留）。客户端重置面板无任何消耗显示，按免费实现
m_servant_energy_reset_tos(conn, obj) {
  const b = S.servants.find(s => s.id === (obj && obj.servant_id));
  if (!b) { log('[energy] reset 未知誓灵', obj && obj.servant_id); conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const before = energySum(b);
  b.energy_points = {};
  saveState();
  log(`[energy] 重置 servant=${b.id}（回收 ${before} 点）`);
  conn.sendToc('m_servant_energy_reset_toc', { servant_id: b.id, team_id: 0 });
},
// 能源转换（提升上限）：吃掉其他誓灵，按 CfgServant[type].getEnergy 给对应属性上限加点
//（prop=0 全属性），单属性封顶 15。提交口径 = 选人列表口径（ServantSelectPanel.filterFunc）：
// 非自身 + 未上阵（canUse），不限颜色/等级——原游戏"确认是否消耗以下稀有誓灵"弹窗
//（SummonDecomposePanel servantFeed 模式）就是为消耗 SR+/10级+ 卡而设，CfgServant.getEnergy
// 也是全稀有度素材表（UR 素材给 2 点）；快捷加点（onBtnUpClick）自动填 N色1级只是挑便宜素材，
// 不是提交规则（2026-09-22 修正：此前误按快捷加点口径限 N色+1级，导致 R 卡提交被拒）。
// 被吃誓灵从存档移除并推 m_servant_update_toc(del) 同步客户端列表
m_servant_energy_ceil_tos(conn, obj) {
  const b = S.servants.find(s => s.id === (obj && obj.servant_id));
  if (!b) { log('[energy] ceil 未知誓灵', obj && obj.servant_id); conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const costIds = Array.isArray(obj && obj.cost_ids) ? obj.cost_ids.map(Number).filter(n => n > 0) : [];
  if (!costIds.length) { log('[energy] ceil 空 cost_ids'); conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const inFormation = id => Object.values(S.formations || {}).some(f => ['field', 'bench', 'fight_field', 'fight_bench']
    .some(k => (f && f[k] || []).some(x => Number(x) === id)))
    || (Object.values((S.towerState && S.towerState.team && S.towerState.team.slots) || {}).some(x => Number(x) === id))
    || Object.values((S.arkState && S.arkState.teams) || {}).some(list => (list || []).includes(Number(id)))
    || Object.values((S.dreamState && S.dreamState.embattle) || {}).some(x => Number(x) === id);
  const fed = [];
  for (const id of costIds) {
    const c = S.servants.find(s => s.id === id);
    if (!c || c.id === b.id) { log(`[energy] ceil 跳过无效目标 ${id}`); continue; }
    if (Number(c.status) !== 0 || inFormation(id)) { log(`[energy] ceil 拒绝 战斗中/已上阵 ${id}`); continue; }
    fed.push(c);
  }
  if (!fed.length) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  if (!b.energy_ceils) b.energy_ceils = ED.ENERGY_PROPS.reduce((o, p) => (o[p] = ED.ENERGY_INIT_CEIL, o), {});
  const gains = {};
  for (const c of fed) {
    const g = feedGainOf(c.type);
    for (const p of ED.ENERGY_PROPS) if (g[p]) gains[p] = (gains[p] || 0) + g[p];
  }
  for (const p of ED.ENERGY_PROPS) {
    b.energy_ceils[p] = Math.min(ED.ENERGY_CEIL_MAX, (Number(b.energy_ceils[p]) || 0) + (gains[p] || 0));
  }
  // 移除被吃誓灵 + 清全部引用（编队/爬塔队/探索队/看板娘组/看板娘指针——
  // helperIdList 悬空会让登录 pushHelperGroup find 不到直接 TypeError）
  const fedIds = fed.map(c => c.id);
  S.servants = S.servants.filter(s => !fedIds.includes(s.id));
  scrubServantRefs(fedIds);
  saveState();
  log(`[energy] 转换 servant=${b.id} 吃=[${fed.map(c => c.type).join(',')}] 上限=${ED.ENERGY_PROPS.map(p => b.energy_ceils[p]).join('/')}`);
  conn.sendToc('m_servant_energy_ceil_toc', {
    servant_id: b.id,
    energys: energyFieldsOf(b).energy,
    points: energyFieldsOf(b).energy_points,
    cost_ids: fedIds,
  });
  // 客户端按 del 列表移除本地 VO（m_servant_update_toc → ServantMgr.removeServant）
  conn.sendToc('m_servant_update_toc', { new: [], update: [], del: fedIds, reward_type: 0 });
  // 被吃誓灵消失 → 名气回落（新增类型 fame=0 条目让客户端移除选人 VO）
  require('./altar').pushFameUpdates(conn);
},
// 誓约破除（兑换商店 11 页签的"誓约破除"入口，SummonModule.toDecompose）：
// 按官方 CfgSummon.decompose 表发金币+破碎之契（score 3，兑换商店货币）。客户端的
// m_servant_decompose_toc handler 是空函数——删誓灵/积分变化全靠 m_servant_update_toc(del)
// 与 m_role_score_change_toc 两个推送驱动（此前兜底只回 toc 不推送 → 誓灵不消失、勋章不加）。
m_servant_decompose_tos(conn, obj) {
  const SHOP = require('../data/shop_data');
  const ECHO = require('../data/echo_shop_data');
  const SD = require('../data/summon_data');
  const ids = Array.isArray(obj && obj.servant_ids) ? obj.servant_ids.map(Number).filter(n => n > 0) : [];
  if (!ids.length) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  const inFormation = id => Object.values(S.formations || {}).some(f => ['field', 'bench', 'fight_field', 'fight_bench']
    .some(k => (f && f[k] || []).some(x => Number(x) === id)))
    || (Object.values((S.towerState && S.towerState.team && S.towerState.team.slots) || {}).some(x => Number(x) === id))
    || Object.values((S.dreamState && S.dreamState.embattle) || {}).some(x => Number(x) === id);
  const colorOf = t => Math.floor(t / 10000) % 10; // typeId 右起第 5 位（Util.indexNum(type,5,5) 同口径）
  const del = [];
  let silver = 0, score = 0, echo = 0;
  for (const id of ids.slice(0, 50)) {          // SummonConst.DECOMPOSE_MAX = 50
    const c = S.servants.find(s => s.id === id);
    if (!c) { log(`[decompose] 跳过无效目标 ${id}`); continue; }
    if (Number(c.status) !== 0 || inFormation(id)) { log(`[decompose] 拒绝 战斗中/已上阵 ${id}`); continue; }
    if ((S.dormState.servants || []).some(d => Number(d.servant_id) === id)) { log(`[decompose] 拒绝 入住宿舍 ${id}`); continue; }
    if (Object.values((S.arkState && S.arkState.teams) || {}).some(list => (list || []).includes(id))) { log(`[decompose] 拒绝 探索队占用 ${id}`); continue; }
    const g = SHOP.DECOMPOSE[colorOf(c.type) - 1] || { sliver: 0, score: 0 };
    silver += g.sliver;
    score += g.score;
    // 回响之契只给"可获回响"的誓灵（客户端 SummonDecomposeSelectPanel 的 lblEcho 同口径：
    // `table.find(getCanGetEchoServantList(), feelingVO.servantType)` 命中才计入预计获得）。
    // 档位取 CfgSummon.decompose[color].echo（UR=100 / SR=5 / R=2 / N=0）；名单里只有 UR，
    // 所以实际只发 UR 档，与"活动赠送/黄金史莱喵不给"的 tip 一致。
    if (ECHO.isEchoType(c.type)) echo += (SD.DECOMPOSE[colorOf(c.type) - 1] || {}).echo || 0;
    del.push(c.id);
  }
  if (!del.length) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
  // 移除 + 清引用（能源转换同款）；祭坛供奉该类型若再无实例，供奉位一并撤下
  S.servants = S.servants.filter(s => !del.includes(s.id));
  scrubServantRefs(del);
  if (S.altarState && S.altarState.enshrined) {
    for (const typeId of Object.keys(S.altarState.enshrined)) {
      if (!S.servants.some(s => Number(s.type) === Number(typeId))) delete S.altarState.enshrined[typeId];
    }
  }
  if (silver) S.roleAsset.silver += silver;
  if (score) L.addScore(conn, SHOP.SCORE_ID, score);
  if (echo) L.addScore(conn, ECHO.SCORE_ID, echo);
  saveState();
  if (silver) pushAssetChange(conn);
  conn.sendToc('m_servant_decompose_toc', { servant_ids: del });
  // 删誓灵 + 名气回落推送（客户端 m_servant_decompose_toc 本身是空 handler，全靠这两个包刷新 UI）
  conn.sendToc('m_servant_update_toc', { new: [], update: [], del, reward_type: 0 });
  require('./altar').pushFameUpdates(conn);
  log(`[decompose] 誓约破除 ${del.length} 只 → 金币+${silver} 破碎之契+${score} 回响之契+${echo}`
    + `（余 ${L.getScore(SHOP.SCORE_ID)}/${L.getScore(ECHO.SCORE_ID)}）`);
},
// 玩家在设置里改看板娘组：保存并回显。
// 客户端 updateHelpGroup 语义：helper = 组首位——若记录的看板娘被移出组，跟随回退到新组首位
  },
  buildFormation: buildFormation, pushTeamReset: pushTeamReset, battleRosterOf: battleRosterOf, teamServantOf: teamServantOf, makeServantBrief: makeServantBrief, pushServantsBrief: pushServantsBrief, pushHelperGroup: pushHelperGroup, helperOrderIds: helperOrderIds, sendFormationBriefs: sendFormationBriefs, servantDetailOf: servantDetailOf, SKIN_CFG: SKIN_CFG, scrubServantRefs: scrubServantRefs, skinTocPayload: skinTocPayload, pushMarrySkinRefresh: pushMarrySkinRefresh,
  briefedIds: briefedIds, pushPendingServants: pushPendingServants, grantServantBrief: grantServantBrief, briefableServants: briefableServants,
  pendingBriefServants: pendingBriefServants,
  pushLineupInfo: pushLineupInfo, pushLineupIfChanged: pushLineupIfChanged, unlockedLineups: unlockedLineups,
  usingSkillsOf: usingSkillsOf, knownSkillIds: knownSkillIds,
  teamsOfServant: teamsOfServant, syncServantTeamIds: syncServantTeamIds, pushServantsTeamChanges: pushServantsTeamChanges,
  scrubServantRefs: scrubServantRefs,
};
