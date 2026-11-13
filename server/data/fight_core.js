// 战斗核心引擎（纯函数）：官方属性公式 / 属性克制 / 技能池 / 自动战斗 AI / 伤害结算
// 依据客户端反编译实证：
// - ServantUtil.realcalcPropVal：hp = ceil(种×lv*0.1)+50+lv*5+ceil(max(点*lv*0.2,点))，其余 = ceil(种×lv*0.05)+12+ceil(max(点*lv*0.1,点))
// - GameConst：水克火/火克风/风克土/土克水/光暗互克；克制×1.75 同属性×0.57；同属性技能威力×1.5（SkillConst.NATURE_ADDITION）
// - FightSkillMgr.findBestSkill/findBestAct：自动选技（治疗优先队友<40%血 → 最大总威力）与目标（克制>群体>低血>普通>抵抗）
// - FightSkillItem/FightMgr：power_point 是技能使用次数，UPDATE_DATA_TYPE_SKILL_PP=1 刷新
const { SKILLS, SERVANT_PHYLE, SERVANT_SKILLBOOK } = require('./skill_data');
const {
  PROP_CODES, PROP_ATTR_NAMES, PROP_FEATURE_IDS, BUFF_IDS, BUFF_FEATURE_IDS,
  encodeAttrVal, encodeBuffVal, SKILL_EFFECT_RULES, getSkillRule,
} = require('./skill_effect_data');
const {
  SERVANT_TALENTS, TALENT_INFO, TALENT_RULES,
  talentOf, talentInfoOf, talentRuleOf,
} = require('./talent_data');
// 元素精灵（Element Awakening）：只读强化数值表（Lv1..10 的 克制%/修正%/回复%/下次攻击%）。
// 状态（rounds/used/servantType）由 map_fight 挂在 unit.element 上，本文件只消费。
const EL = require('./element_data');

// 元素唤醒是否"生效中"（rounds>0）。未装备 = undefined；已唤醒但回合耗尽 = rounds 0。
function elementAwakeOf(actor) {
  const el = actor && actor.element;
  if (!el || !(Number(el.rounds) > 0)) return null;
  return el;
}

// P3 专属技能改写门控（二百二十四/26/27）：客户端 FightMgr.isElementChangeSkill 的服务端等价，
// 四条件缺一不可 —— ①唤醒中(rounds>0) ②本尊专属(servantType===type，泛用=0 恒不触发)
// ③该技能在此誓灵的专属表里 ④对应 order 已解锁(effectIds 由 translate_times 生成)。
function elementExclusiveOf(actor, skillId) {
  const el = elementAwakeOf(actor);
  if (!el || !Number(el.servantType) || Number(el.servantType) !== Number(actor.type)) return null;
  const table = EL.SKILL_DETAILS[actor.type];
  if (!table) return null;
  const hit = Object.keys(table).map(k => table[k])
    .find(r => Number(r.skillId) === Number(skillId));
  if (!hit || !(Array.isArray(el.effectIds) && el.effectIds.includes(Number(hit.order)))) return null;
  return hit;
}

// 已落地的专属改写行为（P3-A/B/C）：键 = "誓灵type:技能id"（同一基础技能可被不同誓灵改写成不同效果）
const ELEMENT_EXCLUSIVE_BEHAVIORS = {
  '1331006:10027': { sureHit: true, refire: 'onKill' },  // 暴风雪：必中 + 击败后再释放（每回合一次）
  '3446003:10380': { critForce: true },                  // 军刀突刺：必暴（+防穿）
  '1044029:10128': { critForce: true },                  // 巨神的豪腕：必暴（+下回合无法行动，沙尘/击倒除外）
  '3445005:10385': { refire: 'onKill', refireMul: 1.7 }, // 兔子退散：击败则额外施放一次（+70%，只一次/回合）
  '2541003:10028': { refire: 'onMiss' },                 // 升天海流（2541003 版）：未命中则额外施放一次
  '1141034:10200': { sureHit: true },                    // 燥热的阳炎：必中
  '1235016:10366': { critForce: true },                  // 轰击五星：必定暴击
  '2545001:10267': { critForce: true },                  // 五龙奔袭：必定暴击
};
function elementExclusiveBehavior(actor, skillId) {
  if (!actor || !skillId) return null;
  if (!elementExclusiveOf(actor, skillId)) return null;
  return ELEMENT_EXCLUSIVE_BEHAVIORS[actor.type + ':' + Number(skillId)] || null;
}

// P1 替换型专属（调研-元素精灵全链路贯通方案 §三.2）：专属版**移除/改写了**基础版的子句。
// 门控成立时必须在 applySkillEffects 里抑制 SKILL_EFFECT_RULES，否则基础版的代价会再算一遍。
// 10148 的元素版（连续两回合 -6）与 replace 同批落地；其余 9 条随 P4 补基础规则时再加。
const ELEMENT_REPLACE_BASE = new Set([
  '1142035:10125', // 断罪炎王剑：基础"使用者物攻-2"，专属版无此代价
  '3545004:10406', // 蛋烧冲击：基础只治最低血友方 15%，专属版治全体 15%
  '1045023:10142', // 贤者辉光：基础"15% 自身魔攻+1"，专属版必定自身+随机友方
  '1544015:10148', // 破岩剑：基础每次命中物防-1，专属版连续两回合命中-6
  // P4 基础规则落地后必须同时抑制的（专属实现已含基础子句，否则双重结算）
  '1235016:10110', '2641002:10110', // 心灵魔术：专属层已实现完整交换/抢夺
  '1435019:10144',                  // 恩赐之泉：专属层已含随机+1
  '1342029:10092',                  // 神之雫：专属层已含随机 2 项
  '1346016:10130',                  // 无间轮回：专属乘区已含 2.0/1.5
  '1346016:10204',                  // 月蚀斩：专属乘区已含 1.15/1.25
  '1626006:10149',                  // 神圣祝福：专属层已含本场免暴
  '2545001:10267',                  // 五龙奔袭：专属层已含 1.6×
  '1436039:10338',                  // 生魂刈割：专属层已含护盾增伤
  '3245001:10330',                  // 绝境的希望：专属层已含 30%+每失 1% HP
  '1545002:10075',                  // 终焉咏叹诗：专属层已含敌方魔攻-1~2（基础是自降）
  '1544026:10355',                  // 五谷丰登：专属层已含土系+2/护盾
  '1231010:10301',                  // 拇指吸吮：专属层已含 +2/+1+每友方
  '3442002:10379',                  // 环游世界：专属层已含双方随机-2
  '3445005:10384',                  // 醉人的咖啡：专属层已含 75% 禁疗 + 双防每回合-1
  '1245017:10395',                  // 光辉之剑：专属层已含 150%×3 回合
  '2541003:10386',                  // 施恩：专属层已含 20%+护盾+溢出
  '3443004:10382',                  // 突破逆境：专属层已含较高攻+速度
  '3442002:10378',                  // 心算：专属层已含低防+每回合暴击/攻击
  '1641020:10374',                  // 母河庇佑：专属层已含 15% 盾 + 免降
  '3446003:10381',                  // 狂野紫电：专属层已含 1.75/1.25
  '3446003:10380',                  // 军刀突刺：专属层已含必暴 + 防穿
  '3546003:10410',                  // 红豆魔法：专属层已含击杀 2 项 + 25%
  '1241018:10256',                  // 浊浪激流：专属层已含 +40%
  '1245005:10154',                  // 光速之拳：专属层已含首伤 +2
  '1435019:10150',                  // 圣光之矢：专属层已含技能锁+契约
  '3245001:10329',                  // 简单维修：专属层已含清负+免降+免击倒
  '3046011:10359',                  // 生死审判：专属层已含判决
  '1145030:10343',                  // 蔑视：专属层已含等级+20/天赋双效果
  '1145030:10068',                  // 苍天之拳（1145030）：专属层已含破屏障
  '2545004:10068',                  // 苍天之拳（2545004）：专属层已含破屏障
  '1245005:10140',                  // 涌动之拳（1245005）：专属层已含破屏障
  '3021004:10140',                  // 涌动之拳（3021004）：专属层已含破屏障
  '1242013:10249',                  // 鏖战入狂：专属层已含双方禁辅
  '1044026:10356',                  // 丰满的麦穗：专属层已含均血版
  '3441001:10377',                  // 动物退散：专属层已含嘲讽+形态降能力
  '3041001:10304',                  // 摩竭之噬：专属层已含偷正向+下回合巨额伤害
  '3542001:10362',                  // 小矮人救援：专属层已含 100%/克制+30%
  '3542001:10408',                  // 绿葱蘸酱：专属层已含克制+暴伤
  '1235016:10366',                  // 轰击五星：专属层已含 40%×4
  '3341001:10368',                  // 二次冻结：专属层已含全体 40%
  '3345002:10370',                  // 循环擦盘子：专属层已含 X% + 队友 X/2
  '1234023:10420',                  // 朝圣之路：专属层已含 n*10%/n*20%
  '1446044:10423',                  // 命悬一线：专属层已含 25% 永久
  '3546003:10411',                  // 喷涌的馅料：专属层已含 100%+随机-2
  '1235012:10303',                  // 传说颂唱：专属层已含 +2/+1
  '3242002:10331',                  // 警觉射击：专属层已含 1.5×
  '1234026:10333',                  // 国土一掷：专属层已含未命中追打
  '2631014:10372',                  // 反核弹外壳：专属层已含全队版
  '3443004:10383',                  // 三色宝石：专属层已含全体版
  '3445005:10385',                  // 兔子退散：专属层已含连发
  '2545004:10387',                  // 光熊之拳：专属层已含全队版
  '1341001:10123',                  // 灭世的海啸：专属层已含击倒/暴雨例外
  '2541002:10268',                  // 挥鞭击流：专属层已含 +1/+1
  '1245009:10299',                  // 耀雨之光棘：专属层已含自伤 1/3
  '3043005:10307',                  // 诸天主宰：专属层已含天赐消耗+能力
  '3242002:10332',                  // 末世的乐观：专属层已含全队清负
  '1242013:10352',                  // 魔法锅：专属层已含团队同步
  '3341001:10367',                  // 骚动的绵羊：专属层已含随机衰减
  '3542001:10409',                  // 高温烘烤：专属层已含异常+翻倍
  '3541002:10404',                  // 文火慢炖：专属层已含全扣盾/2-3级
  '3541002:10405',                  // 水燕飞花：专属层已含 3 段/全体降防加攻
]);
function elementReplacesBase(actor, skillId) {
  return !!actor && ELEMENT_REPLACE_BASE.has(Number(actor.type) + ':' + Number(skillId));
}

// P3-B/C 专属改写·伤害乘区（逐目标；唤醒中本尊专属才生效）
function exclusiveDmgMulOf(actor, cfg, t, ctx) {
  if (!t) return 1.0;
  const statSum = u => [101, 102, 103, 104, 105].reduce((s2, p) => s2 + ((u.statLevels && u.statLevels[p]) || 0), 0);
  switch (Number(cfg.id)) {
    case 10256: return 1.40;                                                    // 浊浪激流：伤害+40%
    case 10129:                                                                 // 神罚时刻（1235012 版）：有盾或魔防>0 → +100%
      return actor.type === 1235012 && (t.shield > 0 || ((t.statLevels && t.statLevels[104]) || 0) > 0) ? 2.0 : 1.0;
    case 10204: {                                                               // 月蚀斩：能力总和为负 +15%（夜幕 25%）
      const sum = statSum(t);
      return sum < 0 ? (ctx && ctx.curWeather === WEATHER_IDS.NIGHT ? 1.25 : 1.15) : 1.0;
    }
    case 10130: return t.hp < t.maxHp / 2 ? 2.0 : 1.5;                          // 无间轮回
    case 10381: {                                                               // 狂野紫电：总能力为正 +75%，为负 +25%
      const s2 = statSum(t);
      return s2 > 0 ? 1.75 : (s2 < 0 ? 1.25 : 1.0);
    }
    case 10330: {                                                               // 绝境的希望
      const magAtk = (actor.attrs && actor.attrs.mag_atk) || 0;
      let m = t.hp > magAtk ? 1.30 : 1.0;
      m *= 1 + Math.max(0, 1 - actor.hp / (actor.maxHp || 1));
      return m;
    }
    case 10267: return [1, 2, 3, 4, 6].includes(t.nature) ? 1.6 : 1.0;          // 五龙奔袭
    case 10249: return (ctx && ctx.bst && ctx.bst.supportUsedSide && ctx.bst.supportUsedSide[1 - actor.side]) ? 2.0 : 1.0; // 鏖战入狂
    case 10362: return 2.0;                                                     // 小矮人救援：伤害+100%（克制伤害另乘）
    case 10383: {                                                               // 三色宝石：免疫或已在异常 → +30%
      const has = t.buffs && (t.buffs[BUFF_IDS.BURN] || t.buffs[BUFF_IDS.PARALYSIS] || t.buffs[BUFF_IDS.POISON]);
      return (has || t.talent === 22530) ? 1.3 : 1.0;
    }
    case 10299: {                                                               // 耀雨之光棘：未携带同属性技能仍 1.5 倍
      const sameNature = (actor.skills || []).some(sk => { const sc = skillCfg(sk.id); return sc && Number(sc.nature) === Number(t.nature); });
      return sameNature ? 1.0 : 1.5;
    }
    case 10349: return isTakamagahara(t.type) ? 1.3 : 1.0;                      // 熊熊妒火：对高天原 +30%
    case 10331: {                                                               // 警觉射击（元素版）：目标敌方的攻击意图指向千户/尤莉 → +50%
      const sm = ctx && ctx.bst && ctx.bst.selMap;                             // selMap = {敌方id: 主目标id}（map_fight 意图图）
      const aimId = sm ? Number(sm[t.id]) : 0;
      if (aimId) {
        const aimUnit = (ctx.units || []).find(u => Number(u.id) === aimId);
        if (aimUnit && (Number(aimUnit.type) === 3245001 || Number(aimUnit.type) === 3242002)) return 1.5;
      }
      return 1.0;
    }
    case 10125: return 1 + 0.15 * (t.hearts || 0);                              // 断罪炎王剑：每层红桃 +15%
    case 10338:                                                                 // 生魂刈割：+自身护盾/上限
      return 1 + ((actor.shield || 0) / (actor.maxHp || 1));
    case 10068:                                                                 // 苍天之拳（2545004 版）：<60% +50%
      return actor.type === 2545004 && t.hp < t.maxHp * 0.6 ? 1.5 : 1.0;
    case 10140:                                                                 // 涌动之拳（3021004 版）：目标 3 回合内打过那伽 +65%
      return actor.type === 3021004 && t.hitNagaRoundUntil != null && ctx && ctx.bst && ctx.bst.round <= Number(t.hitNagaRoundUntil) ? 1.65 : 1.0;
    default: return 1.0;
  }
}

// P3-C 护盾通道（照 白 21820 口径：200001 正值 = 客户端 UpdateHP 加盾）
function exclusiveAddShield(actor, u, v, ctx, sid) {
  if (!u || u.hp <= 0 || !(v > 0)) return;
  if (Number(u.nextShieldMul) > 1) { v = Math.round(v * Number(u.nextShieldMul)); u.nextShieldMul = 1; }
  u.shield = (Number(u.shield) || 0) + v;
  ctx && ctx.effects && ctx.effects.push({
    trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [u.id],
    src_type: 3, src_id: sid || 0, id: 60120, effect_phase: ctx.phase || 7,
    change_type: 200001, change_value: [v], remove_round: 0,
  });
}

// P3-C 溅射：以主目标本次伤害为基数对次级目标按百分比追加伤害（追加进本次动作 effect_list）
function exclusiveSplash(actor, mainHurt, pairs, results) {
  if (!(mainHurt > 0) || !pairs || !pairs.length) return;
  pairs.forEach(([t, pct]) => {
    if (!t || t.hp <= 0 || !(pct > 0)) return;
    const dmg = Math.max(1, Math.round(mainHurt * pct));
    const after = Math.max(0, t.hp - dmg);
    t.hp = after;
    results && results.push({ target: t.id, hurt: dmg, final_hp: after, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
  });
}

// P3-C 克制改写：返回覆盖后的 rel 或 null
function exclusiveRelOf(actor, cfg, t, allUnits) {
  if (!elementExclusiveOf(actor, cfg.id)) return null;
  switch (Number(cfg.id)) {
    case 10362: return t.nature === cfg.nature ? 1 : null;               // 小矮人救援：对同属性克制
    case 10174: {                                                        // 暗夜狂潮：对在场外属性克制
      const onField = new Set((allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side).map(u => u.nature));
      return !onField.has(t.nature) ? 1 : null;
    }
    case 10408: return (t.nature === 1 || t.nature === 2) ? 1 : null;    // 绿葱蘸酱：对水火克制
    default: return null;
  }
}

// P3-C 斩杀（生魂刈割）：伤害后目标生命低于阈值 → 就地击倒（改写 results 的 final_hp）
function exclusiveExecute(results, units, threshold) {
  if (!results || !results.length) return;
  results.forEach(e => {
    if (!(Number(e.hurt) > 0) || !(Number(e.final_hp) > 0)) return;
    const v = units && units.find(u => u.id === e.target);
    if (!v || v.hp <= 0) return;
    if (v.hp < (v.maxHp || 1) * (threshold || 0.20)) { v.hp = 0; e.final_hp = 0; }
  });
}

// 受疗方禁疗乘区（醉人的咖啡 10384）：治疗效果降低 75%
function healReceivedMul(t) {
  if (t && (t.healBlockRounds || 0) > 0) return 0;   // 10130 无间轮回：本回合完全禁疗
  let m = 1;
  if (t && (t.healHalfRounds || 0) > 0) m = 0.5;       // 10384 基础：治疗效果 -50%
  else if (t && (t.healBanRounds || 0) > 0) m = 0.25;
  // 10358 守护灵：本回合受到治疗 +20%
  if (t && (t.healReceivedBoostRounds || 0) > 0) m *= 1 + (Number(t.healReceivedBoostPct) || 0) / 100;
  return m;
}

// 攻方「回复量提升」乘区（联动圣器专属段，2026-10-25）：
// 刻刻帝（狂三 +50%）/ 狐笋（白上吹雪 +20%）/ 团子（古河渚 翻倍）/ 鲷鱼烧（每层 +5%）
function healDealtMul(a) {
  const e = a && a.relicMisc && a.relicMisc.excl;
  if (!e) return 1;
  let m = 1 + (e.kurumiHealMul || 0) + (e.fubukiHealMul || 0) + (e.nagisaHealMul || 0);
  if (e.taiyakiHealPerStack) {
    const sm = a.relicMisc && a.relicMisc.stackDmgPerHurt;
    const cap = sm ? sm.max : 4;
    m += e.taiyakiHealPerStack * Math.min(cap, a.relicHurtStacks || 0);
  }
  return m;
}

// P3-B 禁辅判定：辅助技 = 纯治疗（healPct 且非复合）或己方效果
function isSupportSkillCfg(cfg) {
  return !!cfg && ((cfg.healPct && !(cfg.power > 0)) || isFriendEff(cfg.effType));
}

// 技能概率修正总口（批次G-3，二百五十七）：
// 神恩（20350 珀加索斯）「技能追加效果发动几率变为2倍」——所有 rule.* 概率判定统一走这里，
// 避免"再加一条概率类天赋要改 N 处"（既有 4 类判定点：statChanges.chance / buffs.chance /
// chanceFlinch / randomStat.chance）。
function skillChanceMul(actor) {
  return (actor && actor.talent === 20350) ? 2 : 1;
}

// 畏惧施加统一出口（批次G-2）：畏惧标记 + 不屈之心（20450 精卫，畏惧时全能力+1）
// 4 处既有施加点全部改走这里，避免"新增一条天赋要改 N 处"。
function applyFlinch(unit, effects, phase, srcId, atkId) {
  if (!unit || unit.hp <= 0 || unit.flinch) return;
  unit.flinch = true;
  if (unit.talent === 20450) {
    [101, 102, 103, 104, 105].forEach(pp => {
      gainStat(unit, pp, 1, { effects, srcId: 20450, atkId: atkId != null ? atkId : unit.id, srcServantId: unit.id, phase: phase || 7 });
    });
  }
}

// 专属异常施加（复用 rule.buffs 的 buff 结构与 ADD_BUFF 通道；免疫口径简化）
function exclusiveBuffEffect(actor, tar, buffId, phase) {
  const featInfo = BUFF_FEATURE_IDS[buffId] || { apply: 90001 };
  return {
    trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
    src_type: 3, src_id: 0, id: featInfo.apply, effect_phase: phase || 7,
    change_type: 300019, change_value: [buffId], remove_round: 0,
  };
}
// 判决目标（10359 生死审判）"不会获得增益效果"的正面 buff 黑名单（渐进扩充；护盾/治疗不算增益）
const POSITIVE_BUFF_IDS = new Set([10690]); // 10690 心神凝聚（暴击+2）
// WIKI 异常状态口径（2026-11-09）：烧伤(50002)/中毒(50005)/麻痹(50001)/
// 畏惧(flinch 标记)/睡眠(50004)/混乱(50007)/冻结(50003)。
// 注意 50006 嘲讽与 50008 激怒不算异常；畏惧是独立标记不是 buff。
const ABNORMAL_BUFF_IDS = new Set([50001, 50002, 50003, 50004, 50005, 50007]);
function abnormalImmuneConsume(tar) {
  if (!tar) return false;
  if ((tar.noAbnormalRounds || 0) > 0) return true;
  if ((tar.abnormalImmuneCharges || 0) > 0) { tar.abnormalImmuneCharges -= 1; return true; }
  return false;
}
function abnormalWindowBlocked(tar, buffId) {
  return !!tar && ABNORMAL_BUFF_IDS.has(Number(buffId)) && (tar.noAbnormalRounds || 0) > 0;
}
function abnormalBlocked(tar, buffId) {
  if (!tar || !ABNORMAL_BUFF_IDS.has(Number(buffId))) return false;
  if (abnormalImmuneConsume(tar)) {
    return true;
  }
  return false;
}
function flinchBlocked(tar) {
  if (abnormalImmuneConsume(tar)) {
    return true;
  }
  return false;
}

function applyExclusiveBuff(actor, tar, buffId, chance, duration, ctx) {
  if (!tar || tar.hp <= 0) return;
  if (tar.talent === 22530) return;
  if (abnormalWindowBlocked(tar, buffId)) return; // 20970/10353：窗口内免异常（不消耗次数）
  if (tar.talent === 21410 && ABNORMAL_BUFF_IDS.has(Number(buffId))) return; // 21410 正体不明：免异常
  if ((tar.noPositiveRounds || 0) > 0 && POSITIVE_BUFF_IDS.has(buffId)) return; // 判决目标不获增益
  if (tar.buffs && tar.buffs[buffId]) return;
  if (Math.random() * 100 > chance) return;
  if (abnormalBlocked(tar, buffId)) return; // 10375：免疫异常一次（概率命中才消耗）
  tar.buffs = tar.buffs || {};
  tar.buffs[buffId] = { level: 1, duration: duration || 3 };
  ctx && ctx.effects && ctx.effects.push(exclusiveBuffEffect(actor, tar, buffId, ctx.phase));
}

// 官方 6 大标准天气（CfgCopy.lua: 1沙尘 2暴雨 3烈日 4乱流 5圣光 6夜幕）
const WEATHER_IDS = {
  NONE: 0,
  SANDSTORM: 1,  // 沙尘：土系技能伤害 +20%，土系技能命中率 +10%
  RAIN: 2,       // 暴雨：水系技能伤害 +20%，火系技能伤害 -10%，升天海流必中
  SUN: 3,        // 烈日：火系技能伤害 +20%，水系技能伤害 -10%
  TURBULENCE: 4, // 乱流：风系技能伤害 +10%，暴风雪必中，风系技能优先度 +1
  LIGHT: 5,      // 圣光：光系技能伤害 +20%，暗系誓灵所受伤害 +20%
  NIGHT: 6,      // 夜幕：暗系技能伤害 +20%，光系誓灵所受伤害 +20%
};
const VALID_WEATHER_IDS = new Set(Object.values(WEATHER_IDS));

// 回合末回血圣器（CfgItems 11000001~11000004，desc「回合结束时回复N%HP」）。
// 客户端不自行结算圣器，服务端必须实现；展示特性取 FightFeature.lua 的官方治疗条目
// 30531/30541/30551/30561（act=20015 回血动画 + tips="因为…的效果，#tar恢复了#value点生命"）。
const RELIC_ROUND_HEAL = {
  11000001: { pct: 2, feature: 30531 }, // 回复的甘露Lv1
  11000002: { pct: 3, feature: 30541 }, // 回复的甘露Lv2
  11000003: { pct: 5, feature: 30551 }, // 回复的甘露Lv3
  11000004: { pct: 8, feature: 30561 }, // 圣水
  17010004: { pct: 5, feature: 30551 }, // 大蝴蝶结：回合结束时回复5%HP（2026-10-25 补，此前整条漏实现）
};

// 客户端只消费「change_value[目标下标]」（FeatureLoop.dealFeatureEff / showFeature 同规则），
// 所以一条 effect 不能出现「1 个目标 + 多个值」——多出来的值客户端整段丢弃（2026-10-17 鲲实证）。
// 展开规则：
//  · 单目标多值 → 每个值拆一条同目标 effect（属性数值各自生效，飘字也逐条出）
//  · 多目标多值 → 逐目标配一个值拆开（属性/HP 类才有意义；buff/召唤等保持原样）
// ── 战斗单位 wire-id（bid）：客户端原生小 id 段（2026-10-18 一百八十八 审计实施方案 A'）──
// 根因：客户端 FeatureLoop.lua:233 等多处用 TAR_LEFT_SCENE(4001)/TAR_RIGHT_SCENE(4002) 哨兵判断
// 「tar_servant_id 是不是场景伪 id」，≥4001 一律替换成攻击者 → 旧 9 位 id（90000001+/60000001+）
// 全部命中 → 被动飘字/特效/治疗数字错挂到敌方头顶（数值不受影响，服务端算）。
// 方案：引擎内部 id 保持不动（我方=真实誓灵 id，结算/编队/羁绊/MVP/经验全链零改动），新增
// `bid` 字段 = 客户端战斗 id，仅在协议边界映射：
//   · 下发出口（p_fight_servant/p_update/effect/fight_list）→ 用 bid
//   · 回传入口（m_fight_skill_select_tos.select_list[].id）→ bid 反查回单位
// 值域依据（tools/lua_src/FightConst.lua）：TRA_LEFT 1..1999（左/我方）、TRA_RIGHT 2001..3999（右/敌方）、
// 哨兵 4001/4002、助战 5001/7001、地板单位 9001..9999、isLeftID 判定 1~1999/2001~3999。
// 每场战斗一个分配器（闭包计数），跨波/替补进场单调递增，同场绝不复用。
const BID_LEFT_BASE = 100;   // 我方：100..699（600 上限，编队最多 12 单位绰绰有余）
const BID_RIGHT_BASE = 2100; // 敌方：2100..2699（哨兵/助战/地板段全部避开）

function newBidAllocator() {
  let left = BID_LEFT_BASE, right = BID_RIGHT_BASE;
  return {
    next(side) { return side === 0 ? left++ : right++; },
  };
}

// wire id 值域断言（客户端哨兵/助战/地板段零冲突）：
//  1..1999 左 / 2001..3999 右（本实现用 100..699 与 2100..2699）；
//  禁区：4001/4002 场景哨兵、5001/7001 助战、9001..9999 地板单位（isTileUnitID）。
function isWireBid(n) {
  n = Number(n);
  if (!Number.isInteger(n)) return false;
  if (n >= BID_LEFT_BASE && n < BID_LEFT_BASE + 600) return true;
  if (n >= BID_RIGHT_BASE && n < BID_RIGHT_BASE + 600) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 能力等级变更的唯一出口（2026-10-20 一百九十八）
//
// 背景：本文件有 140 处 `statLevels[...] = ...`，其中 36 个天赋只改服务端内存、
// 不推 `change_type=100000`，客户端既没有等级图标变化也没有飘字
// （玩家原话："光扣血不加属性"）。逐个手写 push 极易把
// atk_servant_id / src_id / feature id 写错，而 D9 又要求「一条只能 1 目标 1 值」，
// 所以统一收口到这里：**改值 → 夹 ±6 → 算真实 delta → 生成一条单目标单值事件**。
//
// ctx（全部可省，默认按「持有者自己触发自己」）：
//   effects       目标事件数组（wakeEffects / effects）；不传则只改值不发事件
//   atkId         atk_servant_id（客户端按它查动作桶），默认 unit.id
//   srcId         src_id（天赋/技能 id），默认 unit.talent
//   srcServantId  src_servant_id（效果来源誓灵），默认 unit.id
//   featureId     id（特性表 20001~20008），默认 PROP_FEATURE_IDS[prop]
//   phase         effect_phase，默认 4（技能后结算）
//   srcType       src_type，默认 1（FIGHT_EFF_FEATURE）
//   targetId      事件目标，默认 unit.id（目标不是本人时显式传）
//
// 返回真实变化量；被 ±6 顶住时为 0 且**不发事件**（客户端对 0 会 printError）。
function gainStat(unit, prop, delta, ctx) {
  if (!unit) return 0;
  // P1 纠偏（一百三十三）：四个"写了没人读"的免疫/锁定在这里生效。
  // 只作用于能力等级增减，不拦 HP/护盾（那些走 change_type 200000/200001）。
  let d = Number(delta) || 0;
  if (d < 0 && unit.nightNoDrop && ctx && Number(ctx.atkId) === Number(unit.id) && Number(ctx.srcId) > 0
      && (unit.skills || []).some(s => Number(s.id) === Number(ctx.srcId))) {
    return 0; // 10336 暗夜主宰：夜晚/夜幕下不因自身技能效果降能力（自身技能 id 命中才免）
  }
  if (d < 0) {
    if ((unit.statDownImmuneRounds || 0) > 0) return 0;                       // 10329 简单维修
    if ((unit.shieldImmuneRounds || 0) > 0 && (Number(unit.shield) || 0) > 0) return 0; // 10374 母河庇佑
    if ((unit.debuffDoubleRounds || 0) > 0) d *= 2;                           // 10409 高温烘烤
  } else if (d > 0) {
    if ((unit.defLockRounds || 0) > 0 && Number(prop) === 103) return 0;      // 10033 融甲之爪（物防不可上升）
    if ((unit.noPositiveRounds || 0) > 0) return 0;                           // 10359 生死审判（判决目标不获增益）
    // 22990 法典（三百一十三补实现）：「能力等级无法提升」——TALENT_RULES.codexLockStatUp 此前是
    // 死配置（全库 0 消费方）。只拦 gainStat 正向通道（与 noPositiveRounds 同限制：裸 statLevels
    // 直写不拦，先例照旧）；降级不受影响。
    if (unit.forsetiCodexActive) return 0;
  }
  // 反转（20200 天邪鬼）：「自身能力等级发生变化时，提升变为下降，下降变为提升」
  // ⚠️ 位置在**免疫判定之后**：免疫按"原始方向"判（"不可下降"拦的是本意下降的效果），
  //    反转只改最终方向，否则会出现"因不可下降被拦 → 反转成上升"这类逻辑倒挂。
  // 事件按 final 方向发（客户端看到的就是实际发生的升降）。
  if (d !== 0 && unit.talent === 20200) d = -d;
  // 10186 飞升灵药：飞升中的誓灵提升能力等级时额外 +1 级（只加成正向提升）
  if (d > 0 && (unit.ascendRounds || 0) > 0) d += 1;
  const lv = unit.statLevels || (unit.statLevels = {});
  const oldLv = Number(lv[prop]) || 0;
  const newLv = Math.max(-6, Math.min(6, oldLv + d));
  const real = newLv - oldLv;
  lv[prop] = newLv;
  const attrName = PROP_ATTR_NAMES[prop];
  if (attrName) unit[attrName] = newLv;
  if (real === 0) return 0;
  const o = ctx || {};
  if (!o.effects) return real;
  o.effects.push({
    trigger_count: 0,
    atk_servant_id: o.atkId != null ? o.atkId : unit.id,
    src_servant_id: o.srcServantId != null ? o.srcServantId : unit.id,
    tar_servant_ids: [o.targetId != null ? o.targetId : unit.id],
    src_type: o.srcType != null ? o.srcType : 1,
    src_id: o.srcId != null ? o.srcId : (unit.talent || 0),
    id: o.featureId != null ? o.featureId : (PROP_FEATURE_IDS[prop] || 20001),
    effect_phase: o.phase != null ? o.phase : 4,
    change_type: 100000,
    change_value: [encodeAttrVal(prop, real)],
    remove_round: 0,
  });
  return real;
}

// ── 犹格索托斯（21910 虚空掌控）资源出口：虚空充能 ─────────────────────────────
// 官方描述：「每点虚空提供0.5%的技能吸血和伤害提升；每次虚空充满，自身会提升2级魔攻和
// 其他一项能力；初始50，上限100，每次伤害或受伤获得10点，击败一名誓灵额外获得10点」。
// ⚠️ 充满后虚空**保留在 100**（不清零）：否则 10273「满虚空时会造成混乱」永远不可能触发
//    （旧实现 `if (>=100) void_energy = 0` 正是玩家反馈"每回合都混乱"链条上的另一半）。
//    清空只发生在 10273 的倾泻（settleSkill 顶部），那里同时把 voidFullFired 复位。
// 调用点三处：造成伤害 / 击败额外 / 受到伤害（旧实现漏了受击攒满不加属性）。
function chargeVoid(unit, amount, effects, phase, srcAtkId, rng) {
  if (!unit || unit.talent !== 21910 || !(Number(amount) > 0)) return 0;
  const before = Math.min(100, Math.max(0, Number(unit.void_energy) || 0));
  if (before >= 100) {
    // 兜底：已满但标记丢失（旧存档 / 外部直接赋值的测试路径）→ 补触发一次，避免"满而无属性"
    if (!unit.voidFullFired) fireVoidFull(unit, effects, phase, srcAtkId, rng);
    return 0;
  }
  unit.void_energy = Math.min(100, before + Number(amount));
  if (unit.void_energy >= 100) fireVoidFull(unit, effects, phase, srcAtkId, rng);
  return unit.void_energy - before;
}

function fireVoidFull(unit, effects, phase, srcAtkId, rng) {
  unit.voidFullFired = true;
  const atkId = srcAtkId != null ? srcAtkId : unit.id;
  const roll = (typeof rng === 'function') ? rng : Math.random;
  gainStat(unit, 102, 2, { effects, srcId: 21910, atkId, srcServantId: unit.id, phase });
  const pool = [101, 103, 104, 105, 111, 113, 115];
  const otherP = pool[Math.min(pool.length - 1, Math.floor(roll() * pool.length))] || pool[0];
  gainStat(unit, otherP, 1, { effects, srcId: 21910, atkId, srcServantId: unit.id, phase });
}

// P3-A/B/C 专属改写·施放侧（二百二十四~二十八）：门控 elementExclusiveOf（唤醒中+本尊专属+order 已解锁）。
// 文案带「造成伤害后」的只在本次施放对目标造成伤害时施加（results=本次 settleSkill 的 results）。
// ctx = { units, effects(回合包 effect_list 缓冲), phase, curWeather, bst(battleState) }。
function applyExclusiveCastEffects(actor, cfg, targets, results, ctx) {
  if (!actor || !cfg) return;
  if (!elementExclusiveOf(actor, cfg.id)) return;
  const c = ctx || {};
  const fx = c.effects;
  const ph = c.phase || 7;
  const bst = c.bst || null;
  const damaged = t => !!results && results.some(e => e && e.target === t.id && (Number(e.hurt) || 0) > 0);
  const killed = t => !!results && results.some(e => e && e.target === t.id && (Number(e.hurt) || 0) > 0 && Number(e.final_hp) <= 0);
  // ⚠️ srcType 必须是 3（FIGHT_EFF_SKILL，技能源），**不能落 gainStat 的默认 1**：
  //    sid 传的是**被专属改写的技能 id**（10382 突破逆境 / 10378 心算 / 10384 醉人的咖啡 …），
  //    这些 10xxx 技能 id 绝大多数不在客户端 FightFeature 表里；而 showFeature:97 只在
  //    src_type==1 时才 `GetFeature(src_id, true)` → 缺表 printError「不存在的特性ID」（2026-10-27 真机工单）。
  //    src_type=3 时第二参为 false ⇒ 查不到只返回 nil、不报错、也不弹横幅（本来就没有对应展示条目）。
  //    能力变化的飘字/动画走 effect.id（20001~20008），与 src_id 无关，一点不受影响。
  const gs = (u, p, d, sid) => gainStat(u, p, d, { effects: fx, srcId: sid, srcType: 3, atkId: actor.id, srcServantId: u.id, phase: ph });
  const foes = () => (c.units || []).filter(x => x && x.hp > 0 && x.side !== actor.side);
  const mainHurt = (targets && targets[0] && results) ? Math.max(0, Number((results.find(e => e.target === targets[0].id) || {}).hurt) || 0) : 0;
  (targets || []).forEach(t => {
    if (!t || t.hp <= 0) return;
    // —— P3-A ——
    if (cfg.id === 10380 && damaged(t)) t.defPierceRounds = 3;
    if (cfg.id === 10384 && damaged(t)) { t.healBanRounds = 3; t.coffeeDefDownRounds = 3; }
    if (cfg.id === 10376 && damaged(t)) t.soulPaintRounds = 3;
    // —— P3-B ——
    if (cfg.id === 10200 && damaged(t)) gs(t, 103, -1, 10200);
    if (cfg.id === 10428 && damaged(t)) gs(t, 105, -2, 10428);
    if (cfg.id === 10017 && damaged(t)) { t.critVulnOnce = true; gs(t, 103, -1, 10017); }
    if (cfg.id === 10135 && damaged(t)) { applyExclusiveBuff(actor, t, BUFF_IDS.SLEEP, 10, 3, c); t.critVulnOnce = true; }
    if (cfg.id === 10021 && damaged(t)) applyExclusiveBuff(actor, t, BUFF_IDS.POISON, 100, 3, c);
    if (cfg.id === 10363 && damaged(t)) {
      applyExclusiveBuff(actor, t, BUFF_IDS.BURN, 50, 3, c);
      actor.nextPriorityBonus = 1;
      actor.nextPriorityRound = (bst ? bst.round : 0) + 1;
    }
    if (cfg.id === 10349 && damaged(t)) {
      applyExclusiveBuff(actor, t, BUFF_IDS.BURN, 75, 3, c);
      if (t.buffs && t.buffs[BUFF_IDS.BURN]) [101, 102, 103, 104, 105].forEach(p => gs(t, p, -1, 10349));
    }
    if (cfg.id === 10362 && damaged(t) && Number(t.nature) === Number(cfg.nature)) { // 小矮人救援：克制时随机防御+1
      gs(actor, Math.random() < 0.5 ? 103 : 104, 1, 10362);
    }
    if (cfg.id === 10409 && damaged(t)) {
      applyExclusiveBuff(actor, t, Math.random() < 0.5 ? BUFF_IDS.POISON : BUFF_IDS.BURN, 100, 3, c);
      t.debuffDoubleRounds = Math.max(t.debuffDoubleRounds || 0, 1);
    }
    if (cfg.id === 10019 && damaged(t)) {
      gs(t, 105, -2, 10019); // 基础规则 -1 已在，净 -3
      if (((t.statLevels && t.statLevels[105]) || 0) <= -6 && !(t.buffs && t.buffs[BUFF_IDS.CONFUSION])) {
        t.buffs = t.buffs || {};
        t.buffs[BUFF_IDS.CONFUSION] = { level: 1, duration: 2 };
        fx && fx.push(exclusiveBuffEffect(actor, t, BUFF_IDS.CONFUSION, ph));
      }
    }
    if (cfg.id === 10379 && damaged(t)) {
      [t, actor].forEach(x => [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 2)
        .forEach(p => gs(x, p, -2, 10379)));
    }
    if (cfg.id === 10256 && killed(t)) {
      (c.units || []).forEach(x => {
        if (!x || x.hp <= 0 || x.side === actor.side || x.id === t.id) return;
        [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 3).forEach(p => gs(x, p, -1, 10256));
      });
    }
    if (cfg.id === 10134 && actor.type === 1146023 && damaged(t)) {
      t.healBanRounds = 1;
      t.critVulnMagicRounds = 3;
      gs(t, [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], -1, 10134);
    }
    if (cfg.id === 10134 && actor.type === 1446044 && damaged(t)) {
      (c.units || []).forEach(x => { if (x && x.hp > 0 && x.side !== actor.side) x.healBanRounds = Math.max(x.healBanRounds || 0, 1); });
    }
    // —— P3-C ——
    if (cfg.id === 10065 && damaged(t)) { // 泥炼成丶锤：麻痹 + 其余三敌 75/50/25%
      applyExclusiveBuff(actor, t, BUFF_IDS.PARALYSIS, 100, 3, c);
      const others = foes().filter(x => x.id !== t.id).slice(0, 3);
      exclusiveSplash(actor, mainHurt, others.map((x, i) => [x, [0.75, 0.50, 0.25][i]]), results);
    }
    if (cfg.id === 10366 && damaged(t)) { // 轰击五星：随机 4 敌 40%
      const others = foes().filter(x => x.id !== t.id).sort(() => Math.random() - 0.5).slice(0, 4);
      exclusiveSplash(actor, mainHurt, others.map(x => [x, 0.40]), results);
    }
    if (cfg.id === 10368 && damaged(t)) { // 二次冻结：敌方全体 40%，每层财布 +15%
      let layers = 0;
      (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && (x.talent === 22810 || x.talent === 22820))
        .forEach(x => { layers += Number(x.walletLayers) || 0; x.walletLayers = 0; });
      const pct = 0.40 + 0.15 * layers;
      exclusiveSplash(actor, mainHurt, foes().filter(x => x.id !== t.id).map(x => [x, pct]), results);
    }
    if (cfg.id === 10133 && damaged(t)) { gs(t, 101, -1, 10133); gs(t, 102, -1, 10133); } // 武装解除：+物攻魔攻-1
    if (cfg.id === 10150 && damaged(t)) { // 圣光之矢（1435019）：锁本回合用过的技能 + 额外缔结契约
      t.skillLock = (t.usedSkillsThisRound || []).slice(0, 8);
      t.skillLockRound = (bst ? bst.round : 0) + 1;
      const allies = (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side);
      if (allies.length) { t.erosContractWith = allies[Math.floor(Math.random() * allies.length)].id; t.erosContractRounds = 1; }
    }
    if (cfg.id === 10248 && damaged(t)) { // 疫症播衍：攻击前按携带技能补妖火/毒素
      const ids = (actor.skills || []).map(s => Number(s.id));
      if (ids.includes(10100)) applyExclusiveBuff(actor, t, BUFF_IDS.BURN, 100, 3, c);
      if (ids.includes(10097) || ids.includes(10021)) applyExclusiveBuff(actor, t, BUFF_IDS.POISON, 100, 3, c);
    }
    if (cfg.id === 10248 && killed(t)) { // 疫症播衍：负面状态由随机队友继承
      const debuffs = Object.keys(t.buffs || {}).filter(k => Number(k) >= 50001 && Number(k) <= 50007);
      const living = foes().filter(x => x.id !== t.id);
      if (debuffs.length && living.length) {
        const heir = living[Math.floor(Math.random() * living.length)];
        heir.buffs = heir.buffs || {};
        debuffs.forEach(k => {
          heir.buffs[k] = t.buffs[k];
          // 三百一十三：继承的负面状态补 300019（否则继承者头上无图标）；10248 是技能 id 不在
          // FightFeature ⇒ 按 D9c 用 src_type=3；展示 id 用各异常的官方"生效"条目
          c.effects && c.effects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [heir.id],
            src_type: 3, src_id: 0, id: BUFF_FEATURE_IDS[Number(k)] ? BUFF_FEATURE_IDS[Number(k)].apply : 90001,
            effect_phase: c.phase || 7,
            change_type: 300019,
            change_value: [encodeBuffVal(Number(k), (heir.buffs[k] && heir.buffs[k].level) || 1)],
            remove_round: (heir.buffs[k] && heir.buffs[k].duration) || 3,
          });
        });
        t.buffs = {};
      }
    }
    if (cfg.id === 10299 && damaged(t) && c.curWeather !== WEATHER_IDS.LIGHT && mainHurt > 0) { // 耀雨之光棘：自伤 1/3
      const self = Math.max(1, Math.round(mainHurt / 3));
      actor.hp = Math.max(0, actor.hp - self);
      results && results.push({ target: actor.id, hurt: self, final_hp: actor.hp, shield_hurt: 0, final_shield: Math.max(0, actor.shield || 0), extra: 0 });
    }
    if (cfg.id === 10029 && damaged(t)) { // 黄泉逆流
      const relNow = natureRelate(cfg.nature, t.nature);
      if (relNow !== 1) {
        gs(actor, 102, 1, 10029);
        const maxH = actor.maxHp || 1;
        const yhBefore = actor.hp;
        actor.hp = Math.min(maxH, actor.hp + Math.round(maxH * 0.15));
        // 自回 15% 必须下发结果（否则客户端血条不同步，下一次绝对同步瞬跳——苏摩 23140 同族）
        if (actor.hp > yhBefore) {
          results && results.push({ target: actor.id, hurt: -(actor.hp - yhBefore), final_hp: actor.hp, shield_hurt: 0, final_shield: Math.max(0, actor.shield || 0), extra: 0 });
        }
      } else {
        (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => gs(a, [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], 1, 10029));
      }
    }
    if (cfg.id === 10123 && damaged(t)) { // 灭世的海啸：下回合无法行动（击倒/暴雨除外）+ 每击倒魔攻+1
      if (!killed(t) && c.curWeather !== WEATHER_IDS.RAIN) actor.skipNextAction = true;
      if (killed(t)) gs(actor, 102, 1, 10123);
    }
    if (cfg.id === 10092) { // 神之雫：目标随机 2 项 +2，并按目标实际等级同步（低于自身则不同步）
      const props = [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 2);
      props.forEach(p => {
        gs(t, p, 2, 10092);
        const tl = (t.statLevels && t.statLevels[p]) || 0;
        const al = (actor.statLevels && actor.statLevels[p]) || 0;
        if (tl > al) gs(actor, p, tl - al, 10092);
      });
    }
    if (cfg.id === 10333 && damaged(t)) { // 国土一掷：命中→敌方全体物防-1
      foes().forEach(x => gs(x, 103, -1, 10333));
    }
    if (cfg.id === 10059 && damaged(t)) { // 震撼的大地：天气分支
      if (c.curWeather === WEATHER_IDS.TURBULENCE || c.curWeather === WEATHER_IDS.RAIN) gs(t, 104, -1, 10059);
      else if (c.curWeather === WEATHER_IDS.SUN || c.curWeather === WEATHER_IDS.SANDSTORM) {
        const week = natureRelate(cfg.nature, t.nature) === 1;
        const dmg = Math.max(1, Math.round(t.maxHp * (week ? 0.30 : 0.15)));
        t.hp = Math.max(0, t.hp - dmg);
        results && results.push({ target: t.id, hurt: dmg, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
      } else if (c.curWeather === WEATHER_IDS.LIGHT || c.curWeather === WEATHER_IDS.NIGHT) {
        const hitN = (results || []).filter(e => (Number(e.hurt) || 0) > 0).length;
        (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).slice(0, hitN)
          .forEach(a => gs(a, (a.attrs && a.attrs.phy_atk >= a.attrs.mag_atk) ? 101 : 102, 1, 10059));
      }
    }
    if (cfg.id === 10348 && damaged(t)) { // 须佐的箭羽：下回合仇恨吸引 + 被击计次标记
      t.tauntedBy = actor.id;
      t.tauntRounds = Math.max(t.tauntRounds || 0, 2);
      t.susaMarkRounds = 2;
      t.susaMarkOwner = actor.id;
    }
    if (cfg.id === 10075 && damaged(t)) { // 终焉咏叹诗：烈日/圣光下目标和随机一名魔攻-1~2
      if (c.curWeather === WEATHER_IDS.SUN || c.curWeather === WEATHER_IDS.LIGHT) {
        const d = 1 + (Math.random() < 0.5 ? 1 : 0);
        gs(t, 102, -d, 10075);
        const other = foes().filter(x => x.id !== t.id)[0];
        if (other) gs(other, 102, -d, 10075);
      }
    }
    if (cfg.id === 10083 && damaged(t)) { // 罪人的怨灵：夜/夜幕对主目标以外 100%
      if (c.curWeather === WEATHER_IDS.NIGHT || isNyxNightTime(c.curWeather)) {
        exclusiveSplash(actor, mainHurt, foes().filter(x => x.id !== t.id).map(x => [x, 1.0]), results);
      }
    }
    if (cfg.id === 10033 && damaged(t)) { // 融甲之爪：本回合全队对该目标必暴 + 3 回合物防锁
      t.critVulnTargetRound = 1;
      t.defLockRounds = 3;
    }
    if (cfg.id === 10068 && damaged(t)) { // 苍天之拳（两版）：先破屏障（护盾），再按档位施加
      const hadBarrier = (Number(t.shield) || 0) > 0 || !!t.absoluteDef;
      if (hadBarrier) { t.shield = 0; t.absoluteDef = false; }
      if (actor.type === 2545004) {
        t.nextOutDmgDown = hadBarrier ? 1.0 : 0.30;
        gs(t, 103, hadBarrier ? -6 - ((t.statLevels && t.statLevels[103]) || 0) : -1, 10068);
        if (t.hp < t.maxHp * 0.6) exclusiveSplash(actor, mainHurt, foes().filter(x => x.id !== t.id).map(x => [x, 0.25]), results);
      } else {
        t.nextOutDmgDown = hadBarrier ? 1.0 : 0.30;
        const prop = cfg.type === 1 ? 103 : 104;
        gs(t, prop, hadBarrier ? -6 - ((t.statLevels && t.statLevels[prop]) || 0) : -1, 10068);
      }
    }
    if (cfg.id === 10140) { // 涌动之拳（两版）
      if (actor.type === 1245005 && damaged(t)) {
        t.supportBanRounds = Math.max(t.supportBanRounds || 0, 4);
        t.coffeeDefDownRounds = Math.max(t.coffeeDefDownRounds || 0, 3);
      }
      if (actor.type === 3021004 && damaged(t)) {
        actor.nextDefPierce = true; // 无视目标防御等级提升（本次已结算，留给后续同类技能）
      }
      if (damaged(t)) { // 破屏障/绝对防御（批次H2：「屏障」按官方文案含力量/法力屏障，一并清）
        t.shield = 0; t.absoluteDef = false;
        t.phyBarrierRounds = 0; t.magicBarrierRounds = 0;
      }
    }
    if (cfg.id === 10006) { // 仇恨吸引（3021004 版）：单体转移 + 受击回 10%/防御+1
      actor.grudgeAbsorbRounds = 2;
      foes().forEach(x => { x.tauntedBy = actor.id; x.tauntRounds = Math.max(x.tauntRounds || 0, 2); });
    }
    if (cfg.id === 10395 && damaged(t)) t.lightSwordRounds = 3; // 光辉之剑标记
    if (cfg.id === 10407 && damaged(t) && cfg.nature !== 5) t.sweetDreamRounds = 3; // 甜蜜梦境标记
    if (cfg.id === 10371 && damaged(t)) { // 水神抄本：目标与融合角色魔防-1~2（融合=克塔亚特天赋 22790 绑定的敌方，技能只消费不生产）
      gs(t, 104, -(1 + (Math.random() < 0.5 ? 1 : 0)), 10371);
      (c.units || []).filter(x => x && x.hp > 0 && x.side !== actor.side && x.id !== t.id
        && !(targets || []).some(tt => tt && tt.id === x.id) // 已在 targets 里的走外层 forEach，避免双重 -1~2
        && (x.cthyllaBoundRounds || 0) > 0 && Number(x.cthyllaBoundUnitId) === Number(actor.id))
        .forEach(x => gs(x, 104, -(1 + (Math.random() < 0.5 ? 1 : 0)), 10371));
    }
    if (cfg.id === 10125 && damaged(t)) { // 断罪炎王剑：施加红桃印记（上限 3，爱丽丝同口径）——专属乘区吃层数
      t.hearts = Math.min(3, (t.hearts || 0) + 1);
    }
    if (cfg.id === 10271 && damaged(t)) { // 根源恐惧：非混沌（阵营 26）夺取 1 级魔攻魔防
      if (Math.floor(t.type / 100000) % 100 !== 26) {
        gs(t, 102, -1, 10271);
        gs(t, 104, -1, 10271);
        gs(actor, 102, 1, 10271);
        gs(actor, 104, 1, 10271);
      }
    }
  });
  // —— 全体/自身类 ——
  if (cfg.id === 10110) { // 心灵魔术（两版）
    const props = [101, 102, 103, 104, 105];
    if (actor.type === 1235016) {
      // 1235016：清双方负向 → 抢夺目标随机 3 种正向；不足 3 种则自身随机 3 项 +1
      [actor, ...(targets || [])].forEach(x => {
        if (!x || x.hp <= 0) return;
        props.forEach(p => { const lv = (x.statLevels && x.statLevels[p]) || 0; if (lv < 0) gs(x, p, -lv, 10110); });
      });
      const t0 = targets && targets[0];
      if (t0 && t0.hp > 0) {
        const pos = props.filter(p => ((t0.statLevels && t0.statLevels[p]) || 0) > 0)
          .sort(() => Math.random() - 0.5).slice(0, 3);
        pos.forEach(p => { const n = t0.statLevels[p] || 0; gs(t0, p, -n, 10110); gs(actor, p, n, 10110); });
        if (pos.length < 3) props.sort(() => Math.random() - 0.5).slice(0, 3).forEach(p => gs(actor, p, 1, 10110));
      }
    } else if (actor.type === 2641002) {
      // 2641002：清自身正向 → 与目标交换全部能力等级
      props.forEach(p => { const lv = (actor.statLevels && actor.statLevels[p]) || 0; if (lv > 0) gs(actor, p, -lv, 10110); });
      const t0 = targets && targets[0];
      if (t0 && t0.hp > 0) {
        props.forEach(p => {
          const a = (actor.statLevels && actor.statLevels[p]) || 0;
          const b = (t0.statLevels && t0.statLevels[p]) || 0;
          if (a !== b) { gs(actor, p, b - a, 10110); gs(t0, p, a - b, 10110); }
        });
      }
    }
  }
  if (cfg.id === 10352) { // 魔法锅（1242013）：清目标负向 → 己方全体提升相同属性/级数
    const t0 = targets && targets[0];
    if (t0 && t0.hp > 0) {
      const gain = {};
      [101, 102, 103, 104, 105].forEach(p => {
        const lv = (t0.statLevels && t0.statLevels[p]) || 0;
        if (lv < 0) { gs(t0, p, -lv, 10352); gain[p] = -lv; }
      });
      (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
        Object.keys(gain).forEach(k => gs(a, Number(k), gain[k], 10352));
      });
    }
  }
  if (cfg.id === 10144) { // 恩赐之泉（1435019）：回15%，较高攻+1、随机+1；姻缘箭矢再+2
    (targets || []).forEach(t => {
      if (!t || t.hp <= 0) return;
      const maxH = t.maxHp || 1;
      const want = Math.max(1, Math.round(maxH * 0.15));
      const after = Math.min(maxH, t.hp + want);
      if (after > t.hp) { fx && fx.push({ trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id], src_type: 3, src_id: 10144, id: 60120, effect_phase: ph, change_type: 200000, change_value: [after - t.hp], remove_round: 0 }); t.hp = after; }
      const hi = (t.attrs && t.attrs.phy_atk >= t.attrs.mag_atk) ? 101 : 102;
      gs(t, hi, 1, 10144);
      const rest = [101, 102, 103, 104, 105].filter(p => p !== hi);
      gs(t, rest[Math.floor(Math.random() * rest.length)], 1, 10144);
      if (t.erosContractWith) gs(t, hi, 2, 10144);
    });
  }
  if (cfg.id === 10370) { // 循环擦盘子（3345002）：X=敌方平均失去血量%；自身 X%，下回合其余友方 X/2%
    const alive = foes();
    const avg = alive.length ? alive.reduce((s2, x) => s2 + Math.max(0, 1 - x.hp / (x.maxHp || 1)), 0) / alive.length : 0;
    actor.nextOutDmgUp = (Number(actor.nextOutDmgUp) || 0) + avg;
    const rd = (bst ? bst.round : 0) + 1;
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id)
      .forEach(a => { a.nextRoundDmgUp = Math.max(Number(a.nextRoundDmgUp) || 0, avg / 2); a.nextRoundDmgUpRound = rd; });
  }
  if (cfg.id === 10105) { // 心神凝聚（1135024）：己方全体进入心神凝聚（基础仅自身）
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side)
      .forEach(a => applyExclusiveBuff(actor, a, 10690, 100, 5, c));
  }
  if (cfg.id === 10089) { // 魔力赐福（1241007）：其余队友魔攻+1（基础仅自身+2）
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id).forEach(a => gs(a, 102, 1, 10089));
  }
  if (cfg.id === 10063 && damaged(targets && targets[0])) { // 大地波动（1544001）：对附近单位 50% 溅射
    const near = foes().filter(x => x.id !== targets[0].id);
    if (near.length) exclusiveSplash(actor, mainHurt, [[near[Math.floor(Math.random() * near.length)], 0.50]], results);
  }
  if (cfg.id === 10204) { // 月蚀斩：目标总和非负时随机清除一项正向等级
    (targets || []).forEach(t => {
      if (!t || t.hp <= 0) return;
      const sum = [101, 102, 103, 104, 105].reduce((s2, p) => s2 + ((t.statLevels && t.statLevels[p]) || 0), 0);
      if (sum >= 0) {
        const pos = [101, 102, 103, 104, 105].filter(p => ((t.statLevels && t.statLevels[p]) || 0) > 0);
        if (pos.length) { const p = pos[Math.floor(Math.random() * pos.length)]; gs(t, p, -((t.statLevels[p]) || 0), 10204); }
      }
    });
  }
  if (cfg.id === 10028 && damaged(targets && targets[0])) { // 升天海流（两版）
    if (actor.type === 2541003) (targets || []).forEach(t => { if (t && t.hp > 0) gs(t, 104, -2, 10028); });
    if (actor.type === 2631014) {
      const cand = (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && !(x.springRounds > 0));
      if (cand.length) cand[Math.floor(Math.random() * cand.length)].springRounds = 5;
    }
  }
  if (cfg.id === 10303) { // 传说颂唱（1235012）：己方所有阿瓦隆较高攻+2、较低防+1
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && servantCamp(x.type) === 12).forEach(a => {
      gs(a, 101, 2, 10303);
      gs(a, Math.random() < 0.5 ? 103 : 104, 1, 10303);
    });
  }
  if (cfg.id === 10304) { // 摩竭之噬（3041001）：清除并夺取目标正向等级；无正向则自身魔攻/速度+1
    const t0 = targets && targets[0];
    if (t0 && t0.hp > 0) {
      let stolen = 0;
      [101, 102, 103, 104, 105].forEach(p2 => {
        const lv = (t0.statLevels && t0.statLevels[p2]) || 0;
        if (lv > 0) { gs(t0, p2, -lv, 10304); gs(actor, p2, lv, 10304); stolen += lv; }
      });
      if (stolen === 0) { gs(actor, 102, 1, 10304); gs(actor, 105, 1, 10304); }
      actor.delayedStrike = { targetId: t0.id, round: (bst ? bst.round : 0) + 1, power: 2, skillId: 10304 };
    }
  }
  if (cfg.id === 10377) { // 动物退散（3441001）：嘲讽 + 按技能形态降能力（标记在受击侧消费）
    (targets || []).forEach(t => {
      if (!t || t.hp <= 0) return;
      t.tauntedBy = actor.id;
      t.tauntRounds = Math.max(t.tauntRounds || 0, 3);
      t.animalRepelRounds = 3;
      t.animalRepelOwner = actor.id;
    });
  }
  if (cfg.id === 10392) { // 万物的誓言（1044029）：抵抗非同属性 / 被同属性克制 + 能力提升（3 回合）
    actor.stanceRounds = 3;
    actor.stanceKind = 'resist_non_same';
  }
  if (cfg.id === 10396) { // 虚伪的装束（1241018）：抵抗与敌方同属性的攻击（2 回合）
    actor.stanceRounds = 2;
    actor.stanceKind = 'resist_same_enemy';
  }
  if (cfg.id === 10387) { // 光熊之拳（2545004）：全体先扣当前15%，伤害后回3%上限；回合末随机防御+1（3回合）
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      const cost = Math.max(1, Math.round(a.hp * 0.15));
      a.hp = Math.max(1, a.hp - cost);
      fx && fx.push({ trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [a.id], src_type: 3, src_id: 10387, id: 60120, effect_phase: ph, change_type: 200000, change_value: [-cost], remove_round: 0 });
    });
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      const heal = Math.max(1, Math.round((a.maxHp || 1) * 0.03));
      const after = Math.min(a.maxHp, a.hp + heal);
      if (after > a.hp) { fx && fx.push({ trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [a.id], src_type: 3, src_id: 10387, id: 60120, effect_phase: ph, change_type: 200000, change_value: [after - a.hp], remove_round: 0 }); a.hp = after; }
      a.lightBearRounds = 3;
    });
  }
  if (cfg.id === 10372) { // 反核弹外壳（2631014）：耗20%上限，全队本回合首次伤害降至1并反弹
    const cost = Math.max(1, Math.round((actor.maxHp || 1) * 0.20));
    actor.hp = Math.max(1, actor.hp - cost);
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => { a.firstHitTo1 = true; a.firstHitTo1Round = (bst ? bst.round : 0) + 1; });
    actor.nukeLastRound = bst ? bst.round : 0;
  }
  if (cfg.id === 10359) { // 生死审判（3046011 元素版）：判决目标本场战斗有效（基础版 2 回合走 rule.judgment；§7.1 口径）
    (targets || []).forEach(t => {
      if (t && t.hp > 0) {
        t.judgmentPermanent = true;
        t.judgmentRounds = 99;
        t.noPositiveRounds = 99;
        fx && fx.push({ // 轮回判决横幅（运行时特性表 22710 在位；一条一目标 D9）
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 22710, id: 22710, effect_phase: ph,
          change_type: 200000, change_value: [0], remove_round: 0,
        });
      }
    });
  }
  if (cfg.id === 10343) { // 蔑视（1145030）：等级+20；天赋两种效果同时生效
    actor.levelOverrideBonus = 20;
    actor.arroganceBoth = true;
  }
  if (cfg.id === 10423) { // 命悬一线（1446044）：天赋触发血线/伤害 15%→25%，本场永久
    actor.talentParamOverride = { hpLine: 0.25, dmg: 0.25 };
  }
  if (cfg.id === 10300) { // 逆光贯雷（1245009）：全队附加佛拉格拉克/布里欧纳克（受克制伤害后 +2 攻/魔攻，3回合）
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      a.fragarachRounds = 3;
      a.brionacRounds = 3;
    });
  }
  if (cfg.id === 10002) { // 法力屏障（1345012）：5 回合己方魔法伤害减半 + 每受两次魔法伤害全队较高攻+1
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      a.magicBarrierRounds = 5;
      a.magicBarrierMul = 0.5; // 元素版：减少 1/2（基础规则是 2/3）
      a.magicHitsTaken = 0;
    });
  }
  if (cfg.id === 10154 && bst && bst.firstDmgRound === bst.round && bst.firstDmgActor === actor.id) {
    // 光速之拳（1245005）：本回合第一个造成技能伤害 → 物攻+2、随机防御+2
    gs(actor, 101, 2, 10154);
    gs(actor, Math.random() < 0.5 ? 103 : 104, 2, 10154);
  }
  if (cfg.id === 10420 && damaged(targets && targets[0])) { // 朝圣之路（1234023）：n=己方存活不同属性数
    const ns = new Set((c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).map(x => x.nature));
    const n = ns.size;
    if (n > 0) {
      (targets || []).forEach(t => { if (t && t.hp > 0) t.nextOutDmgDown = Math.min(1, (Number(t.nextOutDmgDown) || 0) + n * 0.10); });
      (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side)
        .forEach(a => { a.nextOutDmgUp = (Number(a.nextOutDmgUp) || 0) + n * 0.20; });
    }
  }
  if (cfg.id === 10142) { // 贤者辉光（1045023）：自身+随机一名友方魔攻+1
    gs(actor, 102, 1, 10142);
    const allies = (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id);
    if (allies.length) gs(allies[Math.floor(Math.random() * allies.length)], 102, 1, 10142);
  }
  if (cfg.id === 10383) { // 三色宝石：敌方全体随机烧伤/麻痹/中毒
    (c.units || []).forEach(x => {
      if (!x || x.hp <= 0 || x.side === actor.side) return;
      applyExclusiveBuff(actor, x, [BUFF_IDS.BURN, BUFF_IDS.PARALYSIS, BUFF_IDS.POISON][Math.floor(Math.random() * 3)], 100, 3, c);
    });
  }
  if (cfg.id === 10356) { // 丰满的麦穗：全队随机 3 项 +1 并平均分配生命
    const allies = (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side);
    allies.forEach(a => [101, 102, 103, 104, 105, 111, 113, 115].sort(() => Math.random() - 0.5).slice(0, 3)
      .forEach(p => gs(a, p, 1, 10356)));
    const total = allies.reduce((s2, a) => s2 + a.hp, 0);
    const each = Math.floor(total / Math.max(1, allies.length));
    allies.forEach(a => {
      const to = Math.min(a.maxHp, each);
      if (to !== a.hp) results && results.push({ target: a.id, hurt: -(to - a.hp), final_hp: to, shield_hurt: 0, final_shield: Math.max(0, a.shield || 0), extra: 0 });
      a.hp = to;
    });
  }
  if (cfg.id === 10378) actor.mentalMathRounds = 4;
  if (cfg.id === 10382) actor.breakthroughRounds = 3;
  if (cfg.id === 10367) { // 骚动的绵羊
    gs(actor, (actor.attrs && actor.attrs.phy_atk >= actor.attrs.mag_atk) ? 101 : 102, 2, 10367);
    const dp = Math.random() < 0.5 ? 103 : 104;
    gs(actor, dp, 2, 10367);
    actor.sheepDecayRounds = 2;
    actor.sheepDecayProp = dp;
  }
  if (cfg.id === 10294) { // 载世宝船
    (targets || []).forEach(t => {
      if (!t || t.hp <= 0) return;
      gs(t, (t.attrs && t.attrs.phy_atk >= t.attrs.mag_atk) ? 101 : 102, 1, 10294);
      gs(t, Math.random() < 0.5 ? 103 : 104, 1, 10294);
      gs(t, 105, 1, 10294);
    });
  }
  if (cfg.id === 10301) { // 拇指吸吮
    gs(actor, 101, 2, 10301);
    gs(actor, 105, 1, 10301);
    (c.units || []).forEach(x => { if (x && x.hp > 0 && x.side === actor.side && x.id !== actor.id) gs(actor, 101, 1, 10301); });
  }
  if (cfg.id === 10129 && actor.type === 2545001) gs(actor, 102, 1 + (Math.random() < 0.5 ? 1 : 0), 10129);
  if (cfg.id === 10122 && actor.type === 1643004) actor.assaultRounds = 2;
  if (cfg.id === 10122 && actor.type === 2541002) {
    [actor].concat((c.units || []).filter(x => x && x.hp > 0 && x.side !== actor.side)).forEach(x => {
      gs(x, 103, -1, 10122);
      gs(x, 104, -1, 10122);
    });
  }
  if (cfg.id === 10268) { gs(actor, 101, 1, 10268); gs(actor, 105, 1, 10268); }
  if (cfg.id === 10087 && actor.type === 1544015) {
    gs(actor, 101, 2, 10087); // 基础规则 +2 已在，净 +4
    actor.supportBanRounds = 4;
  }
  if (cfg.id === 10249 && damaged(targets && targets[0])) {
    actor.supportBanRounds = Math.max(actor.supportBanRounds || 0, 2);
    (c.units || []).forEach(x => { if (x && x.hp > 0 && x.side !== actor.side) x.supportBanRounds = Math.max(x.supportBanRounds || 0, 2); });
  }
  if (cfg.id === 10128) { // 巨神的豪腕：下回合无法行动（击倒/沙尘除外）
    const anyKill = (targets || []).some(t => killed(t));
    if (!anyKill && c.curWeather !== WEATHER_IDS.SANDSTORM) actor.skipNextAction = true;
  }
  if (cfg.id === 10102) { // 自我修复（两版）
    const maxH = actor.maxHp || (actor.attrs && actor.attrs.hp) || actor.hp;
    const gained = Math.max(1, Math.round(maxH * 0.5));
    const after = Math.min(maxH, actor.hp + gained);
    actor.hp = after;
    if (actor.type === 1344028) {
      actor.shield = (Number(actor.shield) || 0) + gained;
      fx && fx.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 3, src_id: 10102, id: 60120, effect_phase: ph,
        change_type: 200000, change_value: [gained], remove_round: 0,
        shield_hurt: 0, final_shield: actor.shield, final_hp: after,
      });
      // 2026-10-27：等量护盾补 200001（round 包 effect 上的 final_shield 字段客户端不读，
      // 护盾条只有 200001 / 被击 final_shield 两条通道）
      fx && fx.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 3, src_id: 10102, id: 60120, effect_phase: ph,
        change_type: 200001, change_value: [gained], remove_round: 0,
      });
    } else {
      fx && fx.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 3, src_id: 10102, id: 60120, effect_phase: ph,
        change_type: 200000, change_value: [gained], remove_round: 0,
        shield_hurt: 0, final_hp: after,
      });
      (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id)
        .forEach(a => exclusiveAddShield(actor, a, Math.max(1, Math.round(a.maxHp * 0.25)), c, 10102));
    }
  }
  if (cfg.id === 10094 && actor.type === 1234023) { // 肉体强化（1234023 版）：每损失 15% 生命 → 物攻物防 +1
    const lost = 1 - actor.hp / (actor.maxHp || 1);
    const stacks = Math.min(6, Math.floor(lost / 0.15));
    const prev = Number(actor.muscleStacks) || 0;
    if (stacks > prev) {
      const d = stacks - prev;
      gs(actor, 101, d, 10094);
      gs(actor, 103, d, 10094);
      actor.muscleStacks = stacks;
    }
  }
  if (cfg.id === 10087 && actor.type === 1242013) { // 激昂战意（1242013 版）：下一次攻击无视物防等级
    actor.nextDefPierce = true;
  }
  if (cfg.id === 10094 && actor.type === 1532004) { // 肉体强化（1532004 版）：回 20% + 3 回合增减伤 30%
    const maxH = actor.maxHp || 1;
    const after = Math.min(maxH, actor.hp + Math.max(1, Math.round(maxH * 0.20)));
    if (after > actor.hp) results && results.push({ target: actor.id, hurt: -(after - actor.hp), final_hp: after, shield_hurt: 0, final_shield: Math.max(0, actor.shield || 0), extra: 0 });
    actor.hp = after;
    actor.fleshBoostRounds = 3;
  }
  if (cfg.id === 10183 && damaged(targets && targets[0])) { // 北冥之海流：自身速度+1 + 本回合己方九霄必暴
    gs(actor, 105, 1, 10183);
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && isJiuxiao(x.type)).forEach(a => { a.critVulnRound = 1; });
    const t0 = targets[0];
    if (t0 && t0.hp > 0 && Number(t0.nature) === 2) { gs(t0, 102, -1, 10183); gs(t0, 104, -1, 10183); }
  }
  if (cfg.id === 10093) { // 明镜止水（1541019 版）：其余九霄队友魔攻+1
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id && isJiuxiao(x.type))
      .forEach(a => gs(a, 102, 1, 10093));
  }
  if (cfg.id === 10008) { // 生命之泉涌（两版）：泉涌 5 回合（每回合 1/12）
    (targets || []).forEach(t => { if (t && t.hp > 0) t.springRounds = 5; });
    if (actor.type === 1544001 && actor.element && actor.element.rounds > 0) { // 女娲觉醒期间成功回血 → 清一次异常
      (targets || []).forEach(t => { if (t && t.hp > 0 && t.buffs) { const k = Object.keys(t.buffs)[0]; if (k) delete t.buffs[k]; } });
    }
    if (actor.type === 3041001) {
      (targets || []).forEach(t => {
        if (t && t.hp > 0 && Number(t.nature) === 1) t.nextOutDmgUp = (Number(t.nextOutDmgUp) || 0) + (t.hp / (t.maxHp || 1)) * 0.60;
      });
      const maxH = actor.maxHp || 1;
      const after = Math.min(maxH, actor.hp + Math.max(1, Math.round(maxH * 0.15)));
      if (after > actor.hp) results && results.push({ target: actor.id, hurt: -(after - actor.hp), final_hp: after, shield_hurt: 0, final_shield: Math.max(0, actor.shield || 0), extra: 0 });
      actor.hp = after;
    }
  }
  if (cfg.id === 10355 && damaged(targets && targets[0])) { // 五谷丰登：土系队友随机+2 + 10% 盾
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.nature === 4).forEach(a => {
      [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 2).forEach(p => gs(a, p, 2, 10355));
      exclusiveAddShield(actor, a, Math.max(1, Math.round(a.maxHp * 0.10)), c, 10355);
    });
  }
  if (cfg.id === 10010) { // 烈日召来（1545002 版）：队友光属性伤害+50% 3 回合
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id).forEach(a => { a.lightDmgUpRounds = 3; });
  }
  if (cfg.id === 10011 && actor.type === 1641020) actor.rainShieldRounds = 5;
  if (cfg.id === 10374 && damaged(targets && targets[0])) { // 母河庇佑：全队 15% 盾 + 有盾免降 3 回合
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      exclusiveAddShield(actor, a, Math.max(1, Math.round(a.maxHp * 0.15)), c, 10374);
      a.shieldImmuneRounds = 3;
    });
  }
  if (cfg.id === 10386) { // 施恩：全队回 20% + 等量护盾，溢出转随机 2 项 +1
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      const maxH = a.maxHp || 1;
      const want = Math.max(1, Math.round(maxH * 0.20));
      const after = Math.min(maxH, a.hp + want);
      const got = after - a.hp;
      const overflow = want - got;
      a.hp = after;
      results && results.push({ target: a.id, hurt: -got, final_hp: after, shield_hurt: 0, final_shield: Math.max(0, a.shield || 0), extra: 0 });
      exclusiveAddShield(actor, a, want, c, 10386);
      if (overflow > 0) [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 2).forEach(p => gs(a, p, 1, 10386));
    });
  }
  if (cfg.id === 10011 && actor.type === 2641013) { // 暴雨召来（2641013 元素版）：暴雨 8 回合 + 期间回合末对融合目标 10% 最大生命
    const endR = (bst ? bst.round : 1) + 8; // 与基础天气通道 +5 同口径（持续 N 回合 = round+N）
    if (results && results.weatherChange) results.weatherChange.weather_end_round = endR;
    if (bst) bst.fusionRainUntil = endR; // 融合雨窗口 = 天气时长（回合末 tick 消费）
  }
  if (cfg.id === 10297) { // 沐雨之祈：己方全员携带气象石-雨 → 暴雨
    const all = (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side);
    if (all.length && all.every(x => (x.usingSkills || []).includes(10011))) {
      results && (results.weatherChange = { start_weather: WEATHER_IDS.RAIN, weather_end_round: (bst ? bst.round : 1) + 5 });
    }
  }
  if (cfg.id === 10080 && damaged(targets && targets[0])) { // 夜魔之宴：召唤夜幕 + 夜幕每暗系+50%
    results && (results.weatherChange = { start_weather: WEATHER_IDS.NIGHT, weather_end_round: (bst ? bst.round : 1) + 5 });
    actor.nightFeastRounds = 3;
  }
  if (cfg.id === 10336) { // 暗夜主宰：4 回合不克制不暴击 + 唤醒中召唤夜幕
    actor.nightLordRounds = 4;
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => { a.nightNoDrop = true; });
    results && (results.weatherChange = { start_weather: WEATHER_IDS.NIGHT, weather_end_round: (bst ? bst.round : 1) + 5 });
  }
  if (cfg.id === 10149) { // 神圣祝福：全场不受暴击 + 受伤 20% 随机防御+1
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => { a.immuneCrit = true; a.holyBless = true; });
  }
  if (cfg.id === 10231) actor.skyGiftStacks = (actor.skyGiftStacks || 0) + 1; // 披靡的烈风：+1 层天之赐
  if (cfg.id === 10307) { // 诸天主宰：消耗所有天之赐
    const n = actor.skyGiftStacks || 0;
    if (n > 0) {
      gs(actor, 111, n, 10307); // 等价重构：走 gainStat（钳制/免疫/事件统一）
      actor.nextCritBonus = (actor.nextCritBonus || 0) + n; // 临时暴击等级（本回合结算用，不写面板）
      gs(actor, [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], 2 * n, 10307);
      actor.skyGiftStacks = 0;
    }
  }
  if (cfg.id === 10203) { // 指引之光：登记光系引导
    if (bst) { bst.guideLightRound = bst.round; bst.guideLightSide = actor.side; }
  }
  if (cfg.id === 10171 && damaged(targets && targets[0])) { // 复仇风暴：主目标与其余敌方双防降至 -1
    const setDown = x => { [103, 104].forEach(p => { const lv = x.statLevels[p] || 0; if (lv > -1) gs(x, p, -1 - lv, 10171); }); };
    (targets || []).forEach(setDown);
    foes().filter(x => !(targets || []).some(t2 => t2.id === x.id)).forEach(setDown);
  }
  if (cfg.id === 10338 && damaged(targets && targets[0])) exclusiveExecute(results, c.units, 0.20); // 生魂刈割斩杀
  if (cfg.id === 10130 && damaged(targets && targets[0])) { // 无间轮回（1346016）：<50% 本回合禁疗；≥50% 随机防御-1
    (targets || []).forEach(t => {
      if (!t || t.hp <= 0) return;
      if (t.hp < t.maxHp / 2) t.healBlockRounds = Math.max(t.healBlockRounds || 0, 1);
      else gs(t, Math.random() < 0.5 ? 103 : 104, -1, 10130);
    });
  }
  if (cfg.id === 10148 && damaged(targets && targets[0])) { // 破岩剑（1544015）：连续两回合命中 → 物防 -6
    (targets || []).forEach(t => {
      if (!t || t.hp <= 0) return;
      t.hitRoundsBy = t.hitRoundsBy || {};
      const cur = bst ? bst.round : 0;
      const last = Number(t.hitRoundsBy[actor.id]);
      if (last && cur - last === 1) {
        const lv = (t.statLevels && t.statLevels[103]) || 0;
        if (lv > -6) gs(t, 103, -6 - lv, 10148);
      }
      t.hitRoundsBy[actor.id] = cur;
      t.defPierceRounds = Math.max(t.defPierceRounds || 0, 1);
    });
  }
  if (cfg.id === 10405 && damaged(targets && targets[0])) { // 水燕飞花：3 连击 + 全体物防-1 + 己方物攻+1
    exclusiveSplash(actor, mainHurt, [[targets[0], 0.25], [targets[0], 0.50]], results);
    foes().forEach(x => gs(x, 103, -1, 10405));
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => gs(a, 101, 1, 10405));
  }
  if (cfg.id === 10408 && damaged(targets && targets[0])) { // 绿葱蘸酱：克制水火后较高攻速+1
    if (targets[0].nature === 1 || targets[0].nature === 2) {
      gs(actor, (actor.attrs && actor.attrs.phy_atk >= actor.attrs.mag_atk) ? 101 : 102, 1, 10408);
      gs(actor, 105, 1, 10408);
    }
  }
  if (cfg.id === 10406 && damaged(targets && targets[0])) { // 蛋烧冲击（专属差异）：全体 15% + 随机防御+1
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      const maxH = a.maxHp || 1;
      const after = Math.min(maxH, a.hp + Math.max(1, Math.round(maxH * 0.15)));
      if (after > a.hp) results && results.push({ target: a.id, hurt: -(after - a.hp), final_hp: after, shield_hurt: 0, final_shield: Math.max(0, a.shield || 0), extra: 0 });
      a.hp = after;
      gs(a, Math.random() < 0.5 ? 103 : 104, 1, 10406);
    });
  }
  if (cfg.id === 10410 && killed(targets && targets[0])) { // 红豆魔法：击杀→己方其余随机 2 项+2 + 下次伤害+25%
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id).forEach(a => {
      [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 2).forEach(p => gs(a, p, 2, 10410));
      a.nextOutDmgUp = (a.nextOutDmgUp || 0) + 0.25;
    });
  }
  if (cfg.id === 10411 && damaged(targets && targets[0])) { // 喷涌的馅料：对毒/烧 100% + 随机 2 项-2
    const burning = foes().filter(x => x.buffs && (x.buffs[50002] || x.buffs[50005]));
    exclusiveSplash(actor, mainHurt, burning.map(x => [x, 1.0]), results);
    burning.forEach(x => [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 2).forEach(p => gs(x, p, -2, 10411)));
  }
  if (cfg.id === 10332) { // 末世的乐观：清己方负向等级，每级下次受伤 -50%
    let cleared = 0;
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => {
      [101, 102, 103, 104, 105].forEach(p => {
        const lv = a.statLevels[p] || 0;
        if (lv < 0) { gs(a, p, -lv, 10332); cleared += -lv; }
      });
    });
    if (cleared > 0) actor.nextInDmgDown = Math.min(1, (actor.nextInDmgDown || 0) + cleared * 0.50);
  }
  if (cfg.id === 10329) { // 简单维修：清目标负面 + 1 回合能力不下降（不被击倒未实现）
    const t0 = targets && targets[0];
    if (t0) {
      [101, 102, 103, 104, 105].forEach(p => { if ((t0.statLevels[p] || 0) < 0) gs(t0, p, -(t0.statLevels[p] || 0), 10329); });
      t0.statDownImmuneRounds = 1;
      t0.noKnockdownRounds = 1;
    }
  }
  if (cfg.id === 10404) { // 文火慢炖：回合末扣盾 + 较高攻速 2~3 ×3 回合
    // 2026-10-27：清盾补 200001 负值增量（10404 无 FightFeature 条目 → 静默 60120）
    if ((Number(actor.shield) || 0) > 0) {
      const had = Math.round(actor.shield);
      actor.shield = 0;
      fx && fx.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 3, src_id: 10404, id: 60120, effect_phase: ph,
        change_type: 200001, change_value: [-had], remove_round: 0,
      });
    }
    actor.slowCookRounds = 3;
  }
  if (cfg.id === 10369) { // 可爱、打钱：每敌随机 3 项-1，己方全体提升所降的 1 级
    const dropped = new Set();
    foes().forEach(x => [101, 102, 103, 104, 105].sort(() => Math.random() - 0.5).slice(0, 3)
      .forEach(p => { gs(x, p, -1, 10369); dropped.add(p); }));
    (c.units || []).filter(x => x && x.hp > 0 && x.side === actor.side).forEach(a => [...dropped].forEach(p => gs(a, p, 1, 10369)));
  }
  if (cfg.id === 10330 === false) { /* noop */ }
}

function splitEffectByTarget(effect) {
  if (!effect) return [];
  const targets = effect.tar_servant_ids || [];
  const values = effect.change_value || [];
  if (values.length <= 1) return [effect];
  const splittable = effect.change_type === 100000 || effect.change_type === 200000;
  if (!splittable) return [effect];
  const out = [];
  // 三百·续：**多值单目标**（tar=1, val=N）必须拆成 N 条同目标条目。
  // 客户端 change_value 是「按目标下标」取值的（FeatureLoop `change_value[slot21]`），
  // tar 只有 1 个时只会消费 values[0]，其余 N-1 项**静默丢失**（不是崩溃，是数值不生效）。
  // 实例：21740 亚巴顿「击倒后把全部负面属性等级转移」/ 21980 / 22170 / 21870 ——
  // 语义就是"同一目标多项能力变化"，官方写法是多条单值。
  const singleTarget = targets.length === 1;
  for (let i = 0; i < values.length; i++) {
    const tar = singleTarget ? targets[0] : (targets[i] != null ? targets[i] : targets[0]);
    if (tar == null) break;
    out.push(Object.assign({}, effect, {
      tar_servant_ids: [tar],
      change_value: [values[i]],
    }));
  }
  return out.length ? out : [effect];
}

// 属性等级变化编码：prop*1000 + (delta+100)（客户端 FightUtil.getAdditionAttrValue）。
// delta = 0 ⇔ 末三位恰为 100。客户端 FightAttrChangeItem.onGUI 拿到 0 会直接
// printError("能力等级变化为0")——这是玩家日志里"报错但不影响玩法"的噪音，
// 但也确实说明服务端发了"没有变化的变化"，三条已知来源：
//   · 能力等级已到 ±6 上限还在同向加成（战吼 10111 叠满后仍发 101100）；
//   · 后土 22670 把土系友军的降级 delta 置 0（每次护住都发一条 0）；
//   · 10014 归还的极光重置属性时写死 encodeAttrVal(101, 0)。
// 这类条目客户端既不改数值，也不该弹一条 0 级飘字，统一在出口丢弃。
function isZeroAttrChange(effect) {
  if (!effect || Number(effect.change_type) !== 100000) return false;
  const vals = effect.change_value || [];
  if (!vals.length) return true;
  return vals.every(v => Number(v) % 1000 === 100);
}

// 空 change_value 的「纯演出型」effect 安全性（三百·续：真机第四关/第六关卡死）。
// 服务端有一批只带 id/tar 用来播横幅/动画、不带数值的条目（21570 独眼暴乱者记仇 /
// 90402 混乱 trigger / 10801 圣器封印 等，形态 `change_type:0, change_value:[]`）。
// 客户端 dealFeatureEff 主循环虽对 `change_value[slot21] or 0` 有保护，但 rage(200003)/
// HP(200000)/SKILL(200002) 等分支**直接拿 change_value[下标] 做算术** ⇒ tar 有目标而
// change_value 为空时取到 nil → "attempt to perform arithmetic" 每帧刷屏卡死。
// 正确形态：**清空 tar**——所有 `ipairs(tar_servant_ids)` 循环体自然不执行（零数值应用、
// 零算术），而横幅/动画由 showFeature 按 id/src_id 独立播放，演出不受影响。
// 形态收口不变量：凡是 change_value 为空的条目，一律不允许携带目标。
function sanitizeEffectTargets(effect) {
  if (!effect) return effect;
  if ((effect.change_value || []).length > 0) return effect;
  if (!(effect.tar_servant_ids || []).length) return effect;
  return Object.assign({}, effect, { tar_servant_ids: [] });
}

// 四个战斗出口的共用收尾：先按目标拆条（D9），再丢掉零变化属性事件。
function flattenEffects(effects) {
  const out = [];
  for (const e of effects || []) {
    if (isZeroAttrChange(e)) continue;
    for (const x of splitEffectByTarget(sanitizeEffectTargets(e))) {
      if (!isZeroAttrChange(x)) out.push(x);
    }
  }
  return out;
}

// ---- 特性"演出"（2026-10-20 工单：次元料理联动天赋没有演出动画）----
// 客户端的特性演出完全由一个配置字段驱动：FightFeature[effect.id].act
//   act(技能id) → Skill[act].fightAct[] → FightAct[].effs[] → EffectMgr.showSpine
// 没有 act 的展示条目（23090/23100/23110/23120 都是）只会弹横幅，永远不播动画；
// 详见 `调研-联动天赋无演出.md`。
// 下面三个 id 是 2026-10-20 在 `tools/lua_remote/src/Config/FightFeature.lua` 的
// 「本地服补充」段新增的演出条目（官方表对这四只联动只给了名字）：
//   230901 傲娇反击 act=20651 → P_gr.animation
//   231001 正气强身 act=20505 → P_jdfy.b
//   231201 软绵回忆 act=20505 → P_jdfy.b
// src_id 仍然填天赋真 id（客户端横幅取 src_id 的名字，见 FeatureLoop.showFeature /
// FeatureTipsLeft.onGUI），id 才是演出条目——两者分离是官方既有写法（如 23060 / 230600）。
// ⚠️ 这三个 id 依赖客户端配置补丁：PCJS 走 buildData() 实时生效，apkbuild 必须重出包。
const FX_23090 = 230901;
const FX_23100 = 231001;
const FX_23120 = 231201;

// 构造一条"天赋演出"effect。changeType=200000 时 changeValue 必须是**负数**：
// 客户端 FeatureLoop.dealFeatureEff 里 hurt = -1 * change_value。
// 参数 actor = 这条演出里"出手"的单位（反击时是烤鸭本人，护盾时是冰糖燕窝，回合末是持天赋者），
// 归因规则与 test_effect_attribution 的静态扫描一致：atk_servant_id 取出手者。
function featureFxEffect(actor, srcId, vfxId, changeType, changeValue, tarIds, phase) {
  return {
    trigger_count: 0,
    atk_servant_id: actor.id,
    src_servant_id: actor.id,
    tar_servant_ids: tarIds,
    src_type: 1, // FIGHT_EFF_FEATURE
    src_id: srcId, // 横幅/特性名
    id: vfxId, // 演出（FightFeature[id].act）
    effect_phase: phase,
    change_type: changeType,
    change_value: changeValue,
    remove_round: 0,
  };
}


// 战斗包来自多个 handler/旧存档，天气字段可能缺失、字符串化或越界。统一归一化，
// 避免行动顺序和伤害结算读取到 NaN/未知天气后出现不可重复的回合结果。
function normalizeWeatherState(battleState) {
  if (!battleState) return null;
  const src = battleState.weather || {};
  let weather = Number(src.start_weather);
  if (!Number.isInteger(weather) || !VALID_WEATHER_IDS.has(weather)) weather = WEATHER_IDS.NONE;
  let end = Number(src.weather_end_round);
  if (!Number.isFinite(end) || end < 0) end = 0;
  end = Math.floor(end);
  if (weather === WEATHER_IDS.NONE) end = 0;
  battleState.weather = { start_weather: weather, weather_end_round: end };
  return battleState.weather;
}

function validateBattleState(battleState, units) {
  const report = { ok: true, repairs: 0 };
  if (!battleState) return report;
  normalizeWeatherState(battleState);
  if (!Number.isInteger(Number(battleState.round)) || Number(battleState.round) < 1) {
    battleState.round = 1; report.ok = false; report.repairs++;
  }
  const seen = new Set();
  for (const u of (units || [])) {
    if (!u || !Number.isFinite(Number(u.id)) || seen.has(u.id)) { report.ok = false; report.repairs++; continue; }
    seen.add(u.id);
    const max = Number.isFinite(Number(u.maxHp)) && Number(u.maxHp) > 0 ? Number(u.maxHp) : 1;
    u.maxHp = max;
    if (!Number.isFinite(Number(u.hp))) { u.hp = 0; report.ok = false; report.repairs++; }
    u.hp = Math.max(0, Math.min(max, Number(u.hp)));
    for (const sk of (u.skills || [])) {
      if (!Number.isFinite(Number(sk.pp)) || Number(sk.pp) < 0) { sk.pp = 0; report.ok = false; report.repairs++; }
      sk.pp = Math.floor(Number(sk.pp));
    }
  }
  return report;
}

// 女娲天赋（20370 生命创造）：自身以外的己方誓灵，物攻、魔攻、物防、魔防、速度提升 15%
function hasNuwaAura(unit, allUnits) {
  if (!unit || !allUnits) return false;
  return allUnits.some(u => u && u.hp > 0 && u.side === unit.side && u.id !== unit.id && u.talent === 20370);
}

// 官方声音类技能 ID 集（含 Vsinger 专属技、歌声、琴声、破灭曲等）
const SOUND_SKILL_IDS = new Set([
  10075, // 终焉咏叹诗
  10084, // 迷惑之声
  10086, // 堕天破灭曲
  10101, // 妖言
  10111, // 战吼
  10187, // 精灵之音
  10189, // 元气之音
  10190, // 活跃的激奏
  10191, // 驰援之音
  10192, // 祝福的琴声
  10195, // 战鼓之音
  10196, // 冠世的琴声
  10205, // 春风之音
  10207, // 繁华之音
  10208, // 勇者的激奏
  10309, // 四相之音
  10311, // 演剧部之声
  10319, // 崩坏琴声
  91011, // 生命的礼赞·改
  91012, // 堕天破灭曲·改
]);

function isSoundSkill(skillId) {
  const sid = Number(skillId);
  if (!sid) return false;
  if (SOUND_SKILL_IDS.has(sid)) return true;
  const cfg = skillCfg(sid);
  if (cfg) {
    if (/声音|歌声|音律|破灭曲|之音|之声|激奏|咏叹|琴声|颂咏/.test(cfg.name || '') ||
        /声音|歌声|音波|乐曲|激奏/.test(cfg.desc || '')) {
      return true;
    }
  }
  return false;
}

// 官方 hololive 联动誓灵 ID 集（夏色祭 2742002、湊阿库娅 2741003、白上吹雪 2744001、虎儿 2845001、雀儿 2843002；真机 CfgServant 实证）
const HOLOLIVE_TYPES = new Set([2741003, 2742002, 2744001, 2845001, 2843002]);
function isHoloServant(type) {
  return HOLOLIVE_TYPES.has(Number(type));
}
const isHolo = isHoloServant;

// 官方 Vsinger 联动誓灵判定（洛天依 1941001/1943004、乐正绫 1944002/1942005、言和 1946003/1945006）
function isVsinger(type) {
  return Math.floor(Number(type) / 100000) === 19;
}

// 官方 Clannad 联动誓灵判定（智代 3144002、杏 3142003、风子 3143004、琴美 3146005、古河渚 3145001）
function isClannad(type) {
  return Math.floor(Number(type) / 100000) === 31;
}

// 剑类圣器判定（威严之剑/天丛云剑、气旋剑/卡拉德波加、暗堕剑/米斯特汀等）
function isSwordRelic(relicId) {
  const tid = Number(relicId) || 0;
  if (!tid) return false;
  return (tid >= 13002001 && tid <= 13002004) || (tid >= 12000001 && tid <= 12000004) || (tid >= 10001001 && tid <= 10001004) || (tid === 17001004 || tid === 17006004 || tid === 17015004);
}

// 延时类技能判定（全局推演 10259、极限预读 10260、摩迦罗 10303/10304 等）
const DELAY_SKILL_IDS = new Set([10259, 10260, 10303, 10304]);
function isDelaySkill(skillId) {
  return DELAY_SKILL_IDS.has(Number(skillId));
}

// 拳类技能判定（炎王之拳 10034、崩岩粉碎拳 10060、苍天之拳 10068、涌动之拳 10140、光速之拳 10154、百炼之拳 10174、英雄之拳 10222 等）
const PUNCH_SKILL_IDS = new Set([10006, 10008, 10024, 10034, 10043, 10057, 10060, 10068, 10078, 10140, 10154, 10174, 10222]);
function isPunchSkill(skillId) {
  const c = skillCfg(skillId);
  return (c && c.name && c.name.includes('拳')) || PUNCH_SKILL_IDS.has(Number(skillId));
}

// 赫菲斯托斯（21520 圣器锻冶）：共享圣器效果给无圣器队友
function applyRelicSharing(units) {
  (units || []).forEach(u => {
    if (u && u.hp > 0 && u.talent === 21520 && u.relicId) {
      (units || []).forEach(ally => {
        // 圣器封印（10116，批次H3）：被封印者不参与共享（既不接受、也不因封印腾出"无圣器"资格）
        if (ally && ally.hp > 0 && ally.side === u.side && ally.id !== u.id && !ally.relicId && !ally.relicSealed) {
          ally.relicId = u.relicId;
          ally.sharedRelicFrom = u.id;
        }
      });
    }

    // 天天座理世（22880 军武大小姐）：己方全员随机获得其他队友携带圣器效果；己方点兔角色额外获得其他点兔角色的圣器效果
    if (u && u.hp > 0 && u.talent === 22880) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      allies.forEach(ally => {
        if (ally.relicSealed) return; // 圣器封印：被封印者不获得共享
        const otherRelicHolders = allies.filter(o => o.id !== ally.id && o.relicId);
        if (otherRelicHolders.length > 0 && !ally.sharedRelicId) {
          const chosen = otherRelicHolders[Math.floor(Math.random() * otherRelicHolders.length)];
          ally.sharedRelicId = chosen.relicId;
          if (!ally.relicId) ally.relicId = chosen.relicId;
        }
        if (isGochuumon(ally.type)) {
          const rabbitHolders = allies.filter(o => o.id !== ally.id && isGochuumon(o.type) && o.relicId);
          if (rabbitHolders.length > 0 && !ally.extraRabbitRelicId) {
            ally.extraRabbitRelicId = rabbitHolders[0].relicId;
          }
        }
      });
    }
  });
}

// 获取誓灵拥有的所有技能属性集（供鲁格 22180 万艺全通）
function unitSkillNatures(unit) {
  const set = new Set();
  (unit.skills || []).forEach(s => {
    const c = skillCfg(s.id);
    if (c && c.nature) set.add(c.nature);
  });
  return set;
}

// 倪克斯（22490 夜之本源）：夜间判定（夜幕天气或真实时间 18:00~06:00）
function isNyxNightTime(curWeather) {
  if (curWeather === WEATHER_IDS.NIGHT) return true;
  if (curWeather === WEATHER_IDS.SUN || curWeather === WEATHER_IDS.LIGHT) return false;
  const hour = new Date().getHours();
  return (hour >= 18 || hour < 6);
}

function isDayTime(curWeather) {
  if (curWeather === WEATHER_IDS.SUN || curWeather === WEATHER_IDS.LIGHT) return true;
  if (curWeather === WEATHER_IDS.NIGHT) return false;
  const hour = new Date().getHours();
  return (hour >= 6 && hour < 18);
}

// 属性映射标准天气（伊邪那岐 22470 国土诞生）
const NATURE_TO_WEATHER = {
  1: WEATHER_IDS.RAIN,        // 水 -> 暴雨
  2: WEATHER_IDS.SUN,         // 火 -> 烈日
  3: WEATHER_IDS.TURBULENCE,  // 风 -> 乱流
  4: WEATHER_IDS.SANDSTORM,   // 土 -> 沙尘
  5: WEATHER_IDS.LIGHT,       // 光 -> 圣光
  6: WEATHER_IDS.NIGHT,       // 暗 -> 夜幕
};

function checkEntranceWeather(units, battleState, currentRound) {
  if (!battleState) return;
  battleState.weather = battleState.weather || { start_weather: 0, weather_end_round: 0 };
  if (battleState.weather.start_weather > 0) return;
  const izanagi = (units || []).find(u => u && u.hp > 0 && u.talent === 22470);
  if (izanagi) {
    const natureCounts = {};
    (units || []).forEach(u => {
      if (u && u.hp > 0 && u.side === izanagi.side) {
        natureCounts[u.nature] = (natureCounts[u.nature] || 0) + 1;
      }
    });
    let maxCount = 0;
    let mainNature = izanagi.nature;
    Object.keys(natureCounts).forEach(nat => {
      if (natureCounts[nat] > maxCount) {
        maxCount = natureCounts[nat];
        mainNature = Number(nat);
      }
    });
    const targetWeather = NATURE_TO_WEATHER[mainNature] || WEATHER_IDS.NONE;
    if (targetWeather > 0) {
      battleState.weather = {
        start_weather: targetWeather,
        weather_end_round: (currentRound || 1) + 5,
      };
    }
  }
}

// 誓灵所属神系/阵营判定
function servantCamp(type) {
  return Math.floor(Number(type) / 100000);
}
function isJiuxiao(type) {
  return servantCamp(type) === 15;
}
function isTakamagahara(type) {
  return servantCamp(type) === 13;
}
function isNorse(type) {
  return servantCamp(type) === 10;
}
function isGochuumon(type) {
  return [3441001, 3442002, 3446003, 3443004, 3445005].includes(Number(type));
}
// CLANNAD 联动誓灵（真机 CfgServant：智代 3144002 / 杏 3142003 / 风子 3143004 / 琴美 3146005 / 古河渚 3145001）
const CLANNAD_TYPES = new Set([3144002, 3142003, 3143004, 3146005, 3145001]);
// 弹幕类技能（Vsinger「弹幕：高能/电波/福利/空耳/吐槽/随心」，小电视 danmakuDmgMul 消费）
function isDanmakuSkill(skillId) {
  const c = skillCfg(skillId);
  return !!(c && c.name && c.name.includes('弹幕'));
}
function isFourBeasts(type) {
  return [1543031, 1544034, 1541033, 1542032].includes(Number(type));
}

// 进场专属天赋判定（伊邪那美 20110、盖布 21170、苏摩 23140、睡美人 23220、玉子烧 23120、青龙 23270 等）
function checkEntranceTalents(units, battleState, currentRound) {
  // 进场天赋改能力等级的地方一律走 gainStat 并收进 effects，
  // 由 settleRoundStartTalents 并入回合事件（否则客户端只看到数值变了、没有任何提示）。
  const effects = [];
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;
    // 伊邪那美（20110 神诞生）：自身出场时，己方全体誓灵随机2项能力提升1级
    if (u.talent === 20110 && !u.izanamiTriggered) {
      u.izanamiTriggered = true;
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      // 官方 desc 双变体（三百一十三·续补）：「自身出场时，己方全体誓灵随机2项能力提升1级；
      // 替补誓灵出场时，随机3项能力提升1级」——替补入场（enteringRound===当回合）给 3 项。
      const propCount = (u.enteringRound != null && battleState && Number(u.enteringRound) === Number(battleState.round)) ? 3 : 2;
      allies.forEach(ally => {
        // 「随机N项」按不重复取；重复取会让同一项 +2
        const shuffled = props.slice().sort(() => Math.random() - 0.5).slice(0, propCount);
        shuffled.forEach(p => {
          gainStat(ally, p, 1, { effects, srcId: 20110, atkId: u.id, srcServantId: u.id, phase: 1 });
        });
      });
    }

    // 盖布（21170 自然调和）：根据己方场上誓灵属性提升对应的能力等级
    // 水(1) -> 魔防(104), 火(2) -> 物攻(101), 风(3) -> 速度(105), 土(4) -> 物防(103), 光(5) -> 魔攻(102), 暗(6) -> 暴击(111)
    if (u.talent === 21170 && !u.gebHarmonized) {
      u.gebHarmonized = true;
      const teammates = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      const natToProp = { 1: 104, 2: 101, 3: 105, 4: 103, 5: 102, 6: 111 };
      u.statLevels = u.statLevels || {};
      teammates.forEach(tm => {
        const nat = natureOf(tm.type);
        const prop = natToProp[nat];
        if (prop) gainStat(u, prop, 1, { effects, srcId: 21170, atkId: u.id, srcServantId: u.id, phase: 1 });
      });
    }

    // 苏摩（23140 永生血酒）：战斗开始时扣除自身当前40%生命，自身获得3层“血铠”
    // ⚠️ 扣血必须随 effects 下发（朱雀 23280 同款 200000 负值）——纯直改内存会让客户端血条
    // 停留在开局满血，直到下一次 final_hp 绝对同步（典型：首次用辅助技时 p_fight.final_hp=自身
    // 当前 HP）才瞬跳 -40%，玩家看到的就是"首次使用心神凝聚大量扣自己的血"（2026-11-01 真机工单）。
    if (u.talent === 23140 && !u.somaBloodArmorDone) {
      u.somaBloodArmorDone = true;
      const somaHpBefore = u.hp;
      u.hp = Math.max(1, Math.floor(u.hp * 0.60));
      u.bloodArmorLayers = 3;
      // 三百一十三：血铠层数下发（CfgBuff[23140] 0~3 层逐级文案+icon，isZeroHide ⇒ level 必须随
      // encodeBuffVal 编码；裸 {id:23140} 会被解成 level=0 被 isZeroHide 拒显）
      effects.push({
        trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
        src_type: 1, src_id: 23140, id: 23140, effect_phase: 1,
        change_type: 300019, change_value: [encodeBuffVal(23140, 3)], remove_round: 0,
      });
      if (u.hp < somaHpBefore) {
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 1, src_id: 23140, id: 23140, effect_phase: 1, // TRIGGER_TIME_ROUND_START（朱雀 23280 同款）
          change_type: 200000, change_value: [-(somaHpBefore - u.hp)], remove_round: 0,
        });
      }
    }

    // 睡美人（23220 沉睡魔咒）：出场后进入沉睡状态，持续2回合
    // （三百一十三：官方 CfgBuff[232200]「沉睡」带 eff 动画+icon——注意 buff id 是 232200 不是天赋
    //   id 23220；显示走 300019，到期在 settleRoundEndTicks 的 sleepCurseRounds 递减处补 300020）
    if (u.talent === 23220 && !u.sleepCurseInitDone) {
      u.sleepCurseInitDone = true;
      u.sleepCurseRounds = 2;
      effects.push({
        trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
        src_type: 1, src_id: 23220, id: 23220, effect_phase: 1,
        change_type: 300019, change_value: [encodeBuffVal(232200, 1)], remove_round: 2,
      });
    }

    // 玉子烧（23120 软绵回忆）：战斗开始时相应角色随机两项能力提升1级
    if (u.talent === 23120 && !u.tamagoyakiEntranceDone) {
      u.tamagoyakiEntranceDone = true;
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const idx1 = Math.floor(Math.random() * props.length);
      const p1 = props[idx1];
      const remainingProps = props.filter((_, idx) => idx !== idx1);
      const p2 = remainingProps[Math.floor(Math.random() * remainingProps.length)];
      u.statLevels = u.statLevels || {};
      [p1, p2].forEach(p => {
        gainStat(u, p, 1, { effects, srcId: 23120, atkId: u.id, srcServantId: u.id, phase: 1 });
      });
    }

        // =========================================================================
    // SR 阶段一（Phase 1）进场天赋
    // =========================================================================
    // 阿努比斯（20940 自然调和）：根据己方场上誓灵属性提升对应的能力等级
    if (u.talent === 20940 && !u.anubisHarmonized) {
      u.anubisHarmonized = true;
      const teammates = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      const natToProp = { 1: 104, 2: 101, 3: 105, 4: 103, 5: 102, 6: 111 };
      u.statLevels = u.statLevels || {};
      teammates.forEach(tm => {
        const nat = natureOf(tm.type);
        const prop = natToProp[nat];
        // src_id 用 20810（宁芙「自然调和」，FightFeature 表内且带 tips「#src吸收了自然的能量！」），
        // 不用 20940 —— 20940 不在客户端表里，src_type=1 会 printError「不存在的特性ID：20940」。
        // 三条自然调和（20810 宁芙 / 20940 阿努比斯 / 21160）官方文案完全同款，共用展示条目。
        if (prop) gainStat(u, prop, 1, { effects, srcId: 20810, atkId: u.id, srcServantId: u.id, phase: 1 });
      });
    }

    // 迦具土（20570 灼热的降生）：出场对一名队友造成生命上限10%伤害，自己物攻上升2级
    // （队友扣血同样必须下发 200000 负值——直改内存 = 客户端血条不同步，苏摩 23140 同族）
    if (u.talent === 20570 && !u.kagutsuchiEntranceDone) {
      u.kagutsuchiEntranceDone = true;
      const teammates = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      if (teammates.length > 0) {
        const victim = teammates[Math.floor(Math.random() * teammates.length)];
        const loss = Math.max(1, Math.floor(victim.maxHp * 0.10));
        const victimHpBefore = victim.hp;
        victim.hp = Math.max(1, victim.hp - loss);
        if (victim.hp < victimHpBefore) {
          effects.push({
            trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [victim.id],
            src_type: 1, src_id: 20570, id: 20570, effect_phase: 1,
            change_type: 200000, change_value: [-(victimHpBefore - victim.hp)], remove_round: 0,
          });
        }
      }
      u.statLevels = u.statLevels || {};
      gainStat(u, 101, 2, { effects, srcId: 20570, atkId: u.id, srcServantId: u.id, phase: 1 });
    }

    // 寅（22010 如虎添翼）：出场时提升1级速度
    if (u.talent === 22010 && !u.yinEntranceSpeedDone) {
      u.yinEntranceSpeedDone = true;
      u.statLevels = u.statLevels || {};
      gainStat(u, 105, 1, { effects, srcId: 22010, atkId: u.id, srcServantId: u.id, phase: 1 });
    }

    // 拇指姑娘（22770 万花）：出场为己方存活角色各播种1颗生命之种
    // （三百一十三：CfgBuff[22770]「生命之种」带 icon+层数显示（isZeroHide+checkVal），服务端
    //   lifeSeeds 此前纯内部字段 = 播种全程不可见；层数走 300019 encodeBuffVal(22770, N) 下发）
    if (u.talent === 22770 && !u.thumbelinaEntranceDone) {
      u.thumbelinaEntranceDone = true;
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      allies.forEach(a => {
        a.lifeSeeds = Math.min(3, (a.lifeSeeds || 0) + 1);
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [a.id],
          src_type: 1, src_id: 22770, id: 22770, effect_phase: 1,
          change_type: 300019, change_value: [encodeBuffVal(22770, a.lifeSeeds)], remove_round: 0,
        });
      });
    }

    // 独角兽（23020 纯洁之兽）：本场战斗内每名己方誓灵可清除一次异常状态
    if (u.talent === 23020 && !u.unicornPurifyInitDone) {
      u.unicornPurifyInitDone = true;
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      allies.forEach(a => {
        a.unicornPurifyAvailable = true;
      });
    }

    // 圣器「木刻海星」等开场自带海星（mkAllyUnit 烤进 unit.starfish，无 wire）：
    // 三百一十三·续补 300019 同步（startStarfishShown 幂等标记；天赋中途授星走各自的 300019 不受影响）
    if ((u.starfish || 0) > 0 && !u.startStarfishShown) {
      u.startStarfishShown = true;
      effects.push({
        trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
        src_type: 1, src_id: 22340, id: 22340, effect_phase: 1,
        change_type: 300019, change_value: [encodeBuffVal(22340, u.starfish)], remove_round: 0,
      });
    }

    // 玉兔（22950 长生不老药）：战斗开始时己方全体各获得一粒长生药
    // （三百一十三·续：初次授予提到战斗开始——CfgBuff[22950] icon=TalentSkillIcom18，全表仅有的
    //   两个带图标天赋 buff 之一，此前纯内部标记零下发；显示走 300019[22950]、消耗在 5763 段
    //   推 300020。登场队友/替补的补发仍由 settleRoundStartTalents 每回合循环负责——那里只对
    //   尚无药者授予，显示随其入场那一包的 born 步播放）
    if (u.talent === 22950 && !u.jadeRabbitInitDone) {
      u.jadeRabbitInitDone = true;
      (units || []).filter(a => a && a.hp > 0 && a.side === u.side).forEach(a => {
        if (a.jadeRabbitElixir) return;
        a.jadeRabbitElixir = true;
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [a.id],
          src_type: 1, src_id: 22950, id: 22950, effect_phase: 1,
          change_type: 300019, change_value: [encodeBuffVal(22950, 1)], remove_round: 0,
        });
      });
    }

    // 午（22050 驹光过隙）：出场后提前额外释放一次神罚时刻（10129），每场战斗一次
    // （三百一十三·续：extraJudgmentOnce 原是死配置——全库 0 消费方，天赋整段未实现；
    //   接线形态与青龙 23270 入场施技同款：首包只认 effect，fight_list 被客户端无视）
    if (u.talent === 22050 && !u.extraJudgmentDone) {
      u.extraJudgmentDone = true;
      const penaltyCfg = skillCfg(10129);
      const penaltyFoes = (units || []).filter(f => f && f.hp > 0 && f.side !== u.side);
      if (penaltyCfg && penaltyFoes.length > 0) {
        const ptar = (penaltyCfg.selEffType === 1 || penaltyCfg.selEffType === 3)
          ? penaltyFoes : [penaltyFoes[Math.floor(Math.random() * penaltyFoes.length)]];
        const pres = settleSkill(u, penaltyCfg, ptar, units, () => 0.5, 0, battleState);
        (pres || []).forEach(r => {
          const dmg = Number(r && r.hurt) || 0;
          if (dmg > 0 && r.target != null) {
            effects.push({
              trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [r.target],
              src_type: 1, src_id: 22050, id: 22050, effect_phase: 1,
              change_type: 200000, change_value: [-dmg], remove_round: 0,
            });
          }
        });
        ((pres && pres.wakeEffects) || []).forEach(e => {
          effects.push(Object.assign({}, e, { effect_phase: 1 }));
        });
      }
    }

    // 128. 凡赛堤（22990 审判）：战斗开始时敌方被添加法典
    // ⚠️ 显示面（三百一十三）：进场包在 start 时早已发出、入场天赋在首次 select 才跑 ⇒
    // 唯一显示通道是首个战斗回合包的 ADD_BUFF（300019，CfgBuff[22990]「法典」官方图标），
    // 写 u.buffs 对显示永远无效。功能面仍走 forsetiCodexActive 标记（易伤 4103 / 锁能力 gainStat /
    // 10394 裁决消费），expire 时在 settleRoundStartTalents 补 300020 摘图标。
    if (u.talent === 22990 && !u.forsetiEntranceDone) {
      u.forsetiEntranceDone = true;
      const foes = (units || []).filter(f => f && f.hp > 0 && f.side !== u.side);
      foes.forEach(f => {
        f.forsetiCodexActive = true;
        f.forsetiCodexRounds = 2;
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [f.id],
          src_type: 1, src_id: 22990, id: 22990, effect_phase: 1, // TRIGGER_TIME_BORN（朱雀 23280 同款）
          change_type: 300019, change_value: [encodeBuffVal(22990, 1)], remove_round: 2,
        });
      });
    }

    // 81. 修普诺斯（22500 梦境破碎）：出场时处于睡眠状态（可自由行动）
    // （三百一十三：u.buffs 写在进场包发出之后 ⇒ 无 300019 客户端永远看不到睡眠图标；
    //   受击移魂路径的 300019（5246 段）本来是对的，此处只补入场这一次）
    if (u.talent === 22500 && !u.hypnosEntranceDone) {
      u.hypnosEntranceDone = true;
      u.buffs = u.buffs || {};
      u.buffs[BUFF_IDS.SLEEP] = { level: 1, duration: 999 };
      effects.push({
        trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
        src_type: 1, src_id: 22500, id: 22500, effect_phase: 1,
        change_type: 300019, change_value: [encodeBuffVal(BUFF_IDS.SLEEP, 1)], remove_round: 0,
      });
    }

    // 82. 塔纳托斯（22510 冥界壁障）：出场时自带40%最大生命护盾
    // （三百一十三：护盾加在进场包发出之后 ⇒ 必须补 200001 增量，否则出场盾不可见——
    //   同族先例：回合末 20% 盾 5692 段 / 苏摩扣血 200000）
    if (u.talent === 22510 && !u.tanatosEntranceDone) {
      u.tanatosEntranceDone = true;
      const shieldVal = Math.max(1, Math.round(u.maxHp * 0.40));
      u.shield = (Number(u.shield) || 0) + shieldVal;
      effects.push({
        trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
        src_type: 1, src_id: 22510, id: 22510, effect_phase: 1,
        change_type: 200001, change_value: [shieldVal], remove_round: 0,
      });
    }

    // 安琪儿（23240 圣光福泽）：出场时将自身基础魔攻30%附加给己方除自身外魔攻最高的誓灵
    if (u.talent === 23240 && !u.angelEntranceDone) {
      u.angelEntranceDone = true;
      const candidates = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      if (candidates.length > 0) {
        const best = candidates.slice().sort((a, b) => (b.attrs && b.attrs.mag_atk || 0) - (a.attrs && a.attrs.mag_atk || 0))[0];
        const bonus = Math.round((u.attrs && u.attrs.mag_atk || 0) * 0.30);
        if (best.attrs) {
          best.attrs.mag_atk += bonus;
          best.angelBorrowedMagAtk = bonus;
        }
      }
    }

    // 青龙（23270 苍之疾走）：出场后释放一个携带的技能。首包（round_start=1）客户端不播 fight_list，
    // 旧实现只发静默 HP effect，玩家看不到动画/伤害数字；改由 map_fight 在第 2 回合以独立行动下发。
    if (u.talent === 23270 && !u.qinglongGallopDone && u.skills && u.skills.length > 0) {
      u.qinglongGallopDone = true;
      u.qinglongPending = true;
    }

    // —— 批次A进场族（二百五十一）——
    // 茨木童子（20150 鬼颜）：出场时所有敌方物攻下降1级
    if (u.talent === 20150 && !u.oniFaceDone) {
      u.oniFaceDone = true;
      (units || []).forEach(f => {
        if (f && f.hp > 0 && f.side !== u.side) {
          gainStat(f, 101, -1, { effects, srcId: 20150, atkId: u.id, srcServantId: f.id, phase: 1 });
        }
      });
    }
    // 宁芙（20810 自然调和）：与阿努比斯 20940 同文案同款（出场时按己方其他誓灵属性提升对应能力等级）
    if (u.talent === 20810 && !u.nymphHarmonized) {
      u.nymphHarmonized = true;
      const teammates = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      const natToProp = { 1: 104, 2: 101, 3: 105, 4: 103, 5: 102, 6: 111 };
      u.statLevels = u.statLevels || {};
      teammates.forEach(tm => {
        const nat = natureOf(tm.type);
        const prop = natToProp[nat];
        if (prop) gainStat(u, prop, 1, { effects, srcId: 20810, atkId: u.id, srcServantId: u.id, phase: 1 });
      });
    }
    // 自然调和（21160，与 20810 宁芙/20940 阿努比斯同文案同款）
    // ⚠️ 21160 既不在 TALENT_RULES、也没有任何誓灵持有（死代码），但保留实现以防补数据；
    //    src_id 同 20940 一律走表内的 20810（缺表 id 在 src_type=1 下会 printError）。
    if (u.talent === 21160 && !u.harmonize21160) {
      u.harmonize21160 = true;
      const mates = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      const natToProp = { 1: 104, 2: 101, 3: 105, 4: 103, 5: 102, 6: 111 };
      u.statLevels = u.statLevels || {};
      mates.forEach(tm => {
        const prop = natToProp[natureOf(tm.type)];
        if (prop) gainStat(u, prop, 1, { effects, srcId: 20810, atkId: u.id, srcServantId: u.id, phase: 1 });
      });
    }
    // 修格斯（22570 蠕动装甲）：登场时提升1级物防魔防（「攻击力低于防御力只造成50%伤害」在伤害段）
    if (u.talent === 22570 && !u.shoggothArmorDone) {
      u.shoggothArmorDone = true;
      gainStat(u, 103, 1, { effects, srcId: 22570, atkId: u.id, srcServantId: u.id, phase: 1 });
      gainStat(u, 104, 1, { effects, srcId: 22570, atkId: u.id, srcServantId: u.id, phase: 1 });
    }
  });
  return effects;
}

// 能力等级倍率公式（按官方 FightUtil.lua getAttrLvToPer: slot2=2 / 命中回避 slot2=3）
function attrLvMul(lv) {
  const n = Math.max(-6, Math.min(6, Math.round(Number(lv) || 0)));
  if (n > 0) return (2 + n) / 2; // +1: 1.5x, +2: 2.0x, +3: 2.5x, +4: 3.0x, +5: 3.5x, +6: 4.0x
  if (n < 0) return 2 / (2 - n); // -1: 0.67x, -2: 0.5x, -3: 0.4x, -4: 0.33x, -5: 0.29x, -6: 0.25x
  return 1.0;
}

function hitDodgeLvMul(lv) {
  const n = Math.max(-6, Math.min(6, Math.round(Number(lv) || 0)));
  if (n > 0) return (3 + n) / 3;
  if (n < 0) return 3 / (3 - n);
  return 1.0;
}

function effectiveSpeed(unit, allUnits, battleState) {
  if (!unit || !unit.attrs) return 0;
  const spdLv = (unit.statLevels && unit.statLevels[105]) != null ? unit.statLevels[105] : (unit.speed_lv || 0);
  const paraMul = (unit.buffs && unit.buffs[BUFF_IDS.PARALYSIS]) ? 0.75 : 1.0;
  const nuwaMul = hasNuwaAura(unit, allUnits) ? 1.15 : 1.0;
  const curWeather = battleState && battleState.weather && battleState.weather.start_weather;
  const izanagiMul = (unit.talent === 22470 && curWeather !== 1) ? 1.50 : 1.0;
  const hasYama = (allUnits || []).some(u => u && u.hp > 0 && u.side === unit.side && u.talent === 22710);
  const yamaSpeedMul = (hasYama && natureOf(unit.type) === 5) ? 1.20 : 1.0;
  // 蜜蜡之翼（20290 伊卡洛斯）：烈日天气时速度减半；乱流天气时速度翻倍（优先度+1 在 sortActors）
  const ikarosWeatherMul = (unit.talent === 20290 && curWeather === WEATHER_IDS.SUN) ? 0.5
    : (unit.talent === 20290 && curWeather === WEATHER_IDS.TURBULENCE) ? 2.0 : 1.0;
  // —— 批次G-2 速度侧（二百五十六）——
  // 黑曜石形态（20070）：HP低于50%时速度减半
  const obsidianMul = (unit.talent === 20070 && unit.hp < unit.maxHp * 0.5) ? 0.5 : 1.0;
  // 正义之心（20340）：处于烧伤/中毒/麻痹时速度提升50%
  const justiceSpeedMul = (unit.talent === 20340 && unit.buffs
    && (unit.buffs[BUFF_IDS.BURN] || unit.buffs[BUFF_IDS.POISON] || unit.buffs[BUFF_IDS.PARALYSIS])) ? 1.5 : 1.0;
  // 雨中的圆舞（20580 河童）：雨天时速度变为1.5倍
  const kappaSpeedMul = (unit.talent === 20580 && curWeather === WEATHER_IDS.RAIN) ? 1.5 : 1.0;
  // 疾走之风（10009）：4回合内己方速度翻倍（批次H1；施放回合算第1回合，回合末递减）
  const teamSpeedMul = (unit.teamSpeedMulRounds || 0) > 0 ? 2.0 : 1.0;
  // 兴奋的秘泉（10168）：目标速度翻倍（3回合，回合末递减）
  const exciteSpringSpeedMul = (unit.exciteSpringRounds || 0) > 0 ? (Number(unit.exciteSpringSpeedMul) || 2.0) : 1.0;
  return Math.round(unit.attrs.speed * attrLvMul(spdLv) * paraMul * nuwaMul * izanagiMul * yamaSpeedMul * ikarosWeatherMul
    * obsidianMul * justiceSpeedMul * kappaSpeedMul * teamSpeedMul * exciteSpringSpeedMul);
}

function initUnitBattleState(unit) {
  if (!unit) return;
  unit.statLevels = unit.statLevels || {
    101: 0, 102: 0, 103: 0, 104: 0, 105: 0, 111: 0, 113: 0, 115: 0,
  };
  unit.buffs = unit.buffs || {};
  unit.phy_atk_lv = unit.statLevels[101] || 0;
  unit.mag_atk_lv = unit.statLevels[102] || 0;
  unit.phy_def_lv = unit.statLevels[103] || 0;
  unit.mag_def_lv = unit.statLevels[104] || 0;
  unit.speed_lv = unit.statLevels[105] || 0;
  unit.crit_hit_lv = unit.statLevels[111] || 0;
  unit.hit_rate_lv = unit.statLevels[113] || 0;
  unit.dodge_rate_lv = unit.statLevels[115] || 0;
  unit.shield = Number(unit.shield) || 0;

  // 专属 UR 天赋状态字段初始化
  if (unit.talent === 21910) {
    unit.void_energy = (unit.void_energy != null ? unit.void_energy : 50);
    // 虚空充满只触发一次（充满后虚空**保留在 100**，由 10273 虚无爆发清空 —— 见 chargeVoid）
    if (unit.voidFullFired == null) unit.voidFullFired = false;
    if (unit.voidBurstSnapshot === undefined) unit.voidBurstSnapshot = null;
  }
  if (unit.talent === 21670) unit.angel_light_stacks = unit.angel_light_stacks || 0;
  if (unit.talent === 23280) {
    unit.zhuqueSelfBoost = unit.zhuqueSelfBoost || 0;
    unit.zhuqueVuln = unit.zhuqueVuln || 0;
  }
  unit.hearts = unit.hearts || 0;
  unit.waterDmgBoostNextRound = unit.waterDmgBoostNextRound || 0;
  unit.hitThisRound = false;
  unit.hitByServants = unit.hitByServants || [];
  unit.shadow_bind = unit.shadow_bind || 0;
  unit.tauntedBy = unit.tauntedBy || null;
  unit.tauntRounds = unit.tauntRounds || 0;
  unit.flinch = false;
  unit.starfish = unit.starfish || 0;
  unit.soundVulnRatio = unit.soundVulnRatio || 0;
  unit.kotoriFireVuln = unit.kotoriFireVuln || 0;
  // 批次F 状态标记族（二百五十四）
  unit.floatRounds = unit.floatRounds || 0;                 // 浮空（10313 连续飞踢）：被攻击必暴
  unit.gazeSkillId = unit.gazeSkillId || null;              // 凝视（10269）：被禁用的招式 id
  unit.gazeRounds = unit.gazeRounds || 0;
  unit.bloodStainStacks = unit.bloodStainStacks || 0;       // 血污（10418 杀戮波动）
  unit.windWalkerMarkedBy = unit.windWalkerMarkedBy || null;// 风行者印记（10275）施印者 id
  unit.lifePillUsed = unit.lifePillUsed || false;           // 长生药（10390 捣药）
  unit.lamentDeferRounds = unit.lamentDeferRounds || 0;     // 哀叹封锁期（10350，3回合一次）
  unit.lastTargetId = unit.lastTargetId || null;
  unit.recordingSkillId = unit.recordingSkillId || null;
  unit.fubukiDmgBoost = unit.fubukiDmgBoost || 0;
  unit.actedThisRound = false;
  unit.yoshinoSpeedDrops = unit.yoshinoSpeedDrops || 0;
  // 第三阶段：克苏鲁与特殊印记天赋状态
  unit.yellowSign = unit.yellowSign || false;
  unit.gatanoHitThisRound = false;
  unit.petrified = unit.petrified || false;
  unit.petrifyRounds = unit.petrifyRounds || 0;
  if (unit.crawling === undefined) unit.crawling = (unit.talent === 21900);

  // 第四阶段：核心战斗状态初始化
  unit.machaTargetId = unit.machaTargetId || null;
  unit.machaCombo = unit.machaCombo || 0;
  if (unit.talent === 21530 && unit.athenaShields === undefined) {
    unit.athenaShields = 2;
    unit.athenaDmgBoostNext = 0;
    unit.athenaDmgBoostCurr = 0;
  }
  unit.demeterNextDmg = unit.demeterNextDmg || 0;
  unit.demeterCurrDmg = unit.demeterCurrDmg || 0;
  unit.osirisNextDmg = unit.osirisNextDmg || 0;
  unit.osirisCurrDmg = unit.osirisCurrDmg || 0;
  unit.pendingFaint = unit.pendingFaint || false;

  // 第五阶段：神话主神与阵营体系状态初始化
  unit.midgardPoison = unit.midgardPoison || false;
  unit.windVulnerableRounds = unit.windVulnerableRounds || 0;
  unit.godBlessingLayers = unit.godBlessingLayers || 0;
  unit.lotusBlessed = unit.lotusBlessed || false;
  unit.firstHitShieldDone = unit.firstHitShieldDone || false;
  unit.hasAttackedAllies = unit.hasAttackedAllies || false;
  unit.waterHitsReceived = unit.waterHitsReceived || 0;
  unit.attackedWaterAllies = unit.attackedWaterAllies || [];
  unit.nextDmgBonus = unit.nextDmgBonus || 0;
  unit.currDmgBonus = unit.currDmgBonus || 0;

  // 第六阶段：后断代誓灵状态初始化
  unit.trueDragonLayers = unit.trueDragonLayers || 0;
  unit.nemainBlood = unit.nemainBlood || 0;
  unit.bloodArmorLayers = unit.bloodArmorLayers || 0;
  unit.walletLayers = unit.walletLayers || 0;
  unit.curseOfDead = unit.curseOfDead || 0;
  unit.chinoStacks = unit.chinoStacks || 0;
  unit.hitsTakenThisRound = unit.hitsTakenThisRound || 0;
  unit.frostErosionDone = unit.frostErosionDone || false;
  unit.strangledThisRound = unit.strangledThisRound || false;
  unit.sleepCurseRounds = unit.sleepCurseRounds || 0;
  unit.cthyllaBoundRounds = unit.cthyllaBoundRounds || 0;
  unit.tamagoyakiCooldown = unit.tamagoyakiCooldown || 0;
  unit.friggaNextBonus = unit.friggaNextBonus || 0;
  unit.xuanwuNextBonus = unit.xuanwuNextBonus || 0;
  unit.hitByTyr = unit.hitByTyr || false;
}


// nature：1水 2火 3风 4土 5光 6暗 7虚（typeId 第 4 位；客户端 ServantConfigVO.nature 同规则）
function natureOf(type) {
  if (type && typeof type === 'object') {
    if (type.customNature != null) return type.customNature;
    if (type.nature != null) return type.nature;
    type = type.type;
  }
  return Math.floor(Number(type) / 1000) % 10;
}
// 颜色档位（第 5 位）：1/2(N/R)→档1 3(SR)→档2 4(UR)→档3 ≥5→档4（GameConst.getStep 同规则）
function stepOf(type) {
  const color = Math.floor(Number(type) / 10000) % 10;
  return color <= 2 ? 1 : Math.min(color - 1, 4);
}
const DEFAULT_PHYLE = [50, 55, 55, 40, 40, 50];
// 星级档位（ServantUtil.getStep）：star<=2→1 否则 star-1。
// **这是客户端面板属性的唯一档位口径**（ServantConfigVO.getPropPhyle 默认 step = getStep(self.star)）——
// 我方誓灵一律用它，进化（升星）才会真正涨属性；敌方怪物无 star，退化按颜色推（stepOf）
function stepOfStar(star) {
  const s = Number(star) || 0;
  return s > 2 ? s - 1 : 1;
}
// step 省略 = 按颜色推（敌方口径）；显式传入 = 按星级档位取（我方誓灵/幻梦战，见 stepOfStar）
function phyleOf(type, step) {
  const tiers = SERVANT_PHYLE[String(type)] || SERVANT_PHYLE[type];
  if (!tiers) return DEFAULT_PHYLE.slice();
  const idx = (step > 0 ? Math.min(step, tiers.length) : stepOf(type)) - 1;
  const t = tiers[idx] || tiers[tiers.length - 1];
  return Array.isArray(t) ? t.slice(0, 6) : DEFAULT_PHYLE.slice();
}

// 属性克制（GameConst.GetNatureRelate，真机 bc 2026-10 版）：0 无关 1 克制 2 抵抗
// 常量权威：GameConst.NATURE_NONE=7("无") / NATURE_VOID=8("虚无")。
// 7 与一切无关（官方最先判）；8 ↔四元素互克、↔光暗互抵抗（双向）、8 对 8 无关；
// 其余：水克火/火克风/风克土/土克水/光暗互克，同属性抵抗。
const NATURE_WEEK = { 1: 2, 2: 3, 3: 4, 4: 1, 5: 6, 6: 5 };
function natureRelate(atkNat, defNat) {
  const a = Number(atkNat), d = Number(defNat);
  if (!a || !d) return 0;
  if (a === 7 || d === 7) return 0;
  if (a === 8 || d === 8) { // 虚无：8v8 无关；对方四元素→克制，对方光暗→抵抗（双向）
    if (a === d) return 0;
    const other = a === 8 ? d : a;
    return other >= 1 && other <= 4 ? 1 : 2;
  }
  if (NATURE_WEEK[a] === d) return 1;
  if (a === d) return 2;
  return 0;
}
function naturePer(relate) {
  return relate === 1 ? 1.75 : relate === 2 ? 0.57 : 1;
}

// 本属性保底魔法箭（skill_data 官方配置）：虚无=60113 魔法箭-虚；7("无")无对应箭，不设键
const MAGIC_ARROW = { 1: 10018, 2: 10037, 3: 10050, 4: 10061, 5: 10071, 6: 10081, 8: 60113 };

// 属性吸收族天赋（二百五十一批次A）：天赋 id → 免疫并吸收的技能属性
// 20060光子吸收(光5)/20080阴气吸收(暗6)/20190水源吸收(水1)/20310土质吸收(土4)/20360风力吸收(风3)/
// 20900热能吸收(火2)/20430浴火(火2，回复段改为魔攻+1)。消费点：settleSkill 伤害段。
const ABSORB_TALENT_NATURE = { 20060: 5, 20080: 6, 20190: 1, 20310: 4, 20360: 3, 20900: 2, 20430: 2 };

// 六维（官方公式 + 能源点 + 突破；附加加成由调用方叠加）
// energyPoints: {1:点数,...}（属性码 1生命 2物攻 3魔攻 4物防 5魔防 6速度）
// step（可选）：种族值档位。我方誓灵传 stepOfStar(brief.star)（与客户端面板同源，进化即涨属性）；
//              敌方怪物省略 → 按 typeId 颜色推（怪物没有 star 字段）
function calcAttrs(type, level, energyPoints, overstep, extra, step, phyleOverride) {
  const lv = Math.max(1, Number(level) || 1);
  const ph = phyleOverride || phyleOf(type, step);
  const ep = energyPoints || {};
  const ex = extra || {};
  const pbonus = code => (lv > 0 ? Math.ceil(Math.max((ep[code] || 0) * lv * 0.1, ep[code] || 0)) : 0);
  const ob = code => Math.ceil(((overstep || 0) * lv) / (code === 1 ? 30 : 60));
  return {
    hp: Math.ceil(ph[0] * lv * 0.1) + Math.ceil(Math.max((ep[1] || 0) * lv * 0.2, ep[1] || 0)) + 50 + lv * 5 + ob(1) + (ex.hp || 0),
    phy_atk: Math.ceil(ph[1] * lv * 0.05) + pbonus(2) + 12 + ob(2) + (ex.phy_atk || 0),
    mag_atk: Math.ceil(ph[2] * lv * 0.05) + pbonus(3) + 12 + ob(3) + (ex.mag_atk || 0),
    phy_def: Math.ceil(ph[3] * lv * 0.05) + pbonus(4) + 12 + ob(4) + (ex.phy_def || 0),
    mag_def: Math.ceil(ph[4] * lv * 0.05) + pbonus(5) + 12 + ob(5) + (ex.mag_def || 0),
    speed: Math.ceil(ph[5] * lv * 0.05) + pbonus(6) + 12 + ob(6) + (ex.speed || 0),
  };
}

function skillCfg(id) {
  return SKILLS[String(id)] || SKILLS[id];
}

// 单位可用技能池（含 PP）：
// 敌方（learned=null）= 技能书中 lv<=level 的全部（视为全学）；
// 我方 = 默认技(lv=0) + learned_skills 中等级达标者 + 本属性魔法箭（保底，始终在）
function buildSkillPool(type, level, learned) {
  const lv = Math.max(1, Number(level) || 1);
  const book = SERVANT_SKILLBOOK[String(type)] || SERVANT_SKILLBOOK[type] || [];
  const ids = [];
  const push = id => { const n = Number(id); if (n > 0 && skillCfg(n) && !ids.includes(n)) ids.push(n); };
  book.forEach(s => {
    if ((s.lv || 0) === 0 || (learned == null && s.lv <= lv) || (learned != null && learned.includes(Number(s.id)) && s.lv <= lv)) push(s.id);
  });
  if (learned != null) push(MAGIC_ARROW[natureOf(type)] || 10018);
  return ids;
}

// 技能书默认技（lv=0 自带）：官方语义——新誓灵出生即已学且默认装在前 3 槽
function defaultSkills(type) {
  const book = SERVANT_SKILLBOOK[String(type)] || SERVANT_SKILLBOOK[type] || [];
  return book.filter(s => (s.lv || 0) === 0)
    .map(s => Number(s.id)).filter(id => id > 0 && !!skillCfg(id));
}

// 我方战斗技能池 = 装备中的 3 槽技能（m_servant_skill_op 配置）+ 本属性魔法箭保底。
// 官方战斗技能栏只显示装备技；未配置/全空时退化为默认技（defaultSkills 由 using_skills 懒初始化兜底）。
// 三百零二：① 装备槽全空再兜一层 defaultSkills——usingSkillsOf 的懒初始化只救"长度≠3"，
// 救不了 [0,0,0] 这种槽位全零形态；② 池内除魔法箭外没有任何攻击技时，自动补已学（learned_skills）
// 里最强的一件（同属性优先）——"学了没装"不再导致 AI 整场只会魔法箭。补的是**战斗池**（客户端
// 战斗技能栏按本池渲染，多出来的技能同样可手动使用），不动存档 using_skills（技能页签保持玩家配置）。
// 敌方（learnedIds 不传）不受影响——敌方箭-only 是官方数据面（wiki 130 关对账过，调研-自动战斗AI与魔法箭.md）。
const MAGIC_ARROW_SET = new Set(Object.values(MAGIC_ARROW).map(Number));
function isAttackSkillId(id) {
  const c = skillCfg(id);
  return !!c && (Number(c.type) === 1 || Number(c.type) === 2) && c.power > 0 && c.power < 9000;
}
function buildUsingPool(type, usingIds, learnedIds) {
  const ids = [];
  (usingIds || []).forEach(id => { const n = Number(id); if (n > 0 && skillCfg(n) && !ids.includes(n)) ids.push(n); });
  if (!ids.length) defaultSkills(type).forEach(id => { if (!ids.includes(id)) ids.push(id); });
  const arrow = MAGIC_ARROW[natureOf(type)] || 10018;
  if (!ids.includes(arrow)) ids.push(arrow);
  if (Array.isArray(learnedIds) && !ids.some(id => isAttackSkillId(id) && !MAGIC_ARROW_SET.has(Number(id)))) {
    const n = natureOf(type);
    const best = learnedIds.map(Number)
      .filter(id => id > 0 && isAttackSkillId(id) && skillCfg(id) && !ids.includes(id) && !MAGIC_ARROW_SET.has(id))
      .sort((a, b) => {
        const ca = skillCfg(a), cb = skillCfg(b);
        // 同属性优先（吃 1.5 倍同属性修正），同属性内比威力
        return ((cb.nature === n ? 10000 : 0) + (cb.power || 0)) - ((ca.nature === n ? 10000 : 0) + (ca.power || 0));
      })[0];
    if (best) ids.push(best);
  }
  return ids;
}

// AI 可用：攻击技（type 1/2 且 0<power<9000）或治疗技（healPct）或辅助增益/减益技
function aiUsable(cfg) {
  if (!cfg) return false;
  if ((cfg.type === 1 || cfg.type === 2) && cfg.power > 0 && cfg.power < 9000) return true;
  if (cfg.healPct > 0) return true;
  if (cfg.type === 3 && getSkillRule(cfg.id)) return true;
  return false;
}

// effType → 目标集合（敌方侧/己方侧；pos=[x,y]，我方 x<0 敌方 x>0）
// 主目标已由 findBestAct/手动选择确定；row/col 类以主目标所在行列展开。
// 完整对照 SkillConst（1xxx 敌方 / 2xxx 己方 / 3xxx 全场 / 4001 天气）：
//   单体敌方 1001 前排任一 1002 前方 1103 前排随机 1004 后排任一 1005 前方后排 1106 后排随机
//            1007 任一 1108 随机 1009/1010 最高/最低血 1011/1012 最高/最低怒
//   敌方直线（同 x 纵深）1051/1052/1153；敌方一排（同 y）1054/1055/1056/1157；敌全体 1058/1059
//   己方 2001 自身；单体 2002/2103/2005/2008/2012/2013/2014/2015/2016；
//        直线 2006/2107；一排 2009/2110；全体 2011/2099/2004
//   全场 3101/3105/3006 单体、3102/3103/3104 直线/一排、3007 全场
//   天气 4001（本服未实现天气 → 空目标，调用方按无目标处理，不得回落打敌人）
const EFF_FOE_ONE = new Set([1001, 1002, 1103, 1004, 1005, 1106, 1007, 1108, 1009, 1010, 1011, 1012]);
const EFF_FOE_COL = new Set([1051, 1052, 1153]);
const EFF_FOE_ROW = new Set([1054, 1055, 1056, 1157]);
const EFF_FOE_ALL = new Set([1058, 1059]);
const EFF_FRIEND_ONE = new Set([2002, 2103, 2005, 2008, 2012, 2013, 2014, 2015, 2016]);
const EFF_FRIEND_COL = new Set([2006, 2107]);
const EFF_FRIEND_ROW = new Set([2009, 2110]);
const EFF_FRIEND_ALL = new Set([2011, 2099, 2004]);
const EFF_ANY_ONE = new Set([3101, 3105, 3006]);
const EFF_ANY_COL = new Set([3102, 3103]);
const EFF_ANY_ROW = new Set([3104]);
// 群体技判定（批次H1 10004 结界盾消费）：敌全体/直线/一排 + 全场。
// 与圣器 rdm.aoe（3802 附近）口径的差异：那里漏了 EFF_FOE_ROW/COL，此处按"命中多个敌方单位"的完整口径收口。
const AOE_EFF_TYPES = new Set([1051, 1052, 1153, 1054, 1055, 1056, 1157, 1058, 1059, 3007]);
function isAoeEffType(effType) {
  return AOE_EFF_TYPES.has(Number(effType) || 0);
}
// 己方向的 effType（调用方据此判断“无目标时不得回落打敌人”）
function isFriendEff(effType) {
  const e = Number(effType) || 0;
  return e === 2001 || EFF_FRIEND_ONE.has(e) || EFF_FRIEND_COL.has(e) || EFF_FRIEND_ROW.has(e) || EFF_FRIEND_ALL.has(e) || e === 4001;
}
// 目标集合解析（所有战斗 handler 的唯一入口）。
// ⚠️ 签名契约（技术债收口 2026-10-26）：**6 参全传**。actor/skillId 缺失会让
//    「依赖施术者/技能的目标改写」静默失效（挑拨离间 20530、安格斯 22200、霍德尔 20760、
//    嘲讽 tauntedBy、超常感知 21840、接触融合 22790、无貌之神 21900 全是这一族）。
//    历史上 dream.js 只传 4 参，导致幻梦战里上述天赋全部不生效（已修）。
//    为防将来新调用点再漏，这里对 actor/skillId 缺失时打一次告警（开发期可见）。
function targetsOfEff(effType, side, units, main, actor, skillId) {
  if (actor === undefined) {
    // 不抛错（旧调用点兼容），但留下可 grep 的痕迹，便于发现遗漏
    if (typeof targetsOfEff._warned !== 'object' || !targetsOfEff._warned) targetsOfEff._warned = {};
    if (!targetsOfEff._warned[side]) {
      targetsOfEff._warned[side] = true;
      try { console.warn('[targetsOfEff] actor 未传入：依赖施术者的目标改写（20530/22200/20760/21840/22790/21900）将不生效'); } catch (_) {}
    }
  }
  const alive = units.filter(u => u.hp > 0);
  const foes = alive.filter(u => u.side !== side);
  const friends = alive.filter(u => u.side === side);
  const e = Number(effType) || 1007;
  // 奈亚拉托提普（21900 无貌之神）：处于伏行状态时，伏行之混沌（10272）攻击全体敌方
  if (skillId === 10272 && actor && actor.crawling) return foes;
  // 米迦勒 10243 天国复仇：上一击击败目标后，本次施放改为攻击敌方全体（heavenVengeance）。
  // 武装在 settleSkill 尾段（results 存在击杀）产生；**清标也只能在 settleSkill**——
  // aiChoose/bestAttackChoice 评分会反复调 targetsOfEff，在这里清会让评分耗掉武装、
  // 真实施放退回单体。装备后本分支返回全体，desc「对目标之外的敌方全体」中的
  // "目标"指上次被击败者（已死，天然不在 foes 里），故按全体结算。
  if (skillId === 10243 && actor && actor.heavenVengeanceArmed) return foes;
  // 站位是「3 排（x）× 3 直线（y）」：
  //   "排"（1054/1055/1056、2009/2110）= 同 x 的一竖排（前/中/后排）
  //   "直线"（1051/1052/1153、2006/2107）= 同 y 的一条纵深线
  // （旧实现的 byRow/byCol 变量名与中文相反但取值正确，这里改名消歧义）
  const sameX = (pool, tar) => pool.filter(u => u.pos[0] === tar.pos[0]);
  const sameY = (pool, tar) => pool.filter(u => u.pos[1] === tar.pos[1]);
  if (e === 4001) return [];                                  // 天气：无单位目标
  if (EFF_FOE_ALL.has(e)) return foes;
  if (EFF_FOE_ROW.has(e)) {
    // 1054/1055 是**绝对排**（客户端 SkillConst：EFF_ENEMY_FRONT_ROW_ALL 前排全部 / BACK_ROW_ALL 后排全部），
    // 不是"主目标所在排"：前排 = 离施法者最近的一排（|x| 最小，与 TILES_BY_COUNT 的 x=2/3 前后排约定一致）。
    // 1056 任意一排 / 1157 随机一排才随主目标走（客户端手动选择由 picker 钉在该排，行为不变）。
    if (e === 1054 || e === 1055) {
      if (!foes.length) return foes;
      const xs = foes.map(u => Math.abs(Number(u.pos[0]) || 0));
      const want = (e === 1054) ? Math.min(...xs) : Math.max(...xs);
      const rows = foes.filter(u => Math.abs(Number(u.pos[0]) || 0) === want);
      return rows.length ? rows : foes;
    }
    return main ? sameX(foes, main) : foes;
  }
  if (EFF_FOE_COL.has(e)) return main ? sameY(foes, main) : foes;
  if (e === 2001) return main && main.side === side ? [main] : friends.slice(0, 1); // 自身
  if (EFF_FRIEND_ALL.has(e)) return friends;
  if (EFF_FRIEND_ROW.has(e)) return main && main.side === side ? sameX(friends, main) : friends;
  if (EFF_FRIEND_COL.has(e)) return main && main.side === side ? sameY(friends, main) : friends;
  if (EFF_FRIEND_ONE.has(e)) return main && main.side === side ? [main] : friends.slice(0, 1);
  if (e === 3007) return alive;
  if (EFF_ANY_ROW.has(e)) return main ? sameX(alive, main) : alive;
  if (EFF_ANY_COL.has(e)) return main ? sameY(alive, main) : alive;
  if (EFF_ANY_ONE.has(e)) return main ? [main] : alive.slice(0, 1);
  if (EFF_FOE_ONE.has(e)) {
    // 112. 安格斯（22200 未逐之爱）：单体攻击技能目标固定为敌方能力等级最高者
    if (actor && actor.talent === 22200 && foes.length > 0) {
      const best = foes.slice().sort((a, b) => {
        const sa = Object.values(a.statLevels || {}).reduce((s, v) => s + Math.abs(v || 0), 0);
        const sb = Object.values(b.statLevels || {}).reduce((s, v) => s + Math.abs(v || 0), 0);
        return sb - sa;
      })[0];
      if (best) return [best];
    }
    // 115. 广目天（22240 清净天眼）：技能选择目标不会被改变（优先返回原始主目标）
    if (actor && actor.talent === 22240 && main && main.side !== side) {
      return [main];
    }
    // 技能级目标锁（批次H1 神明启示 10244 / 元素版警觉射击 10331 挂 skillTargetLocked）：
    // 「目标不会被改变」——与清净天眼同位（压过霍德尔随机/嘲讽/挑拨；安格斯的更强指向在其之前）
    if (actor && actor.skillTargetLocked && main && main.side !== side) {
      return [main];
    }
    // 霍德尔（20760 混乱的黑暗）：单体攻击技能目标变为随机
    if (actor && actor.talent === 20760 && foes.length > 0) {
      return [foes[Math.floor(Math.random() * foes.length)]];
    }

    if (actor && actor.tauntedBy && actor.talent !== 21840 && actor.talent !== 21240 && !actor.skillTargetLocked) {
      const taunter = foes.find(u => u.id === actor.tauntedBy);
      if (taunter) return [taunter];
    }
    // 挑拨离间（20530 拉塔托斯克）：「以其为对象的单体攻击技能，会随机转移到范围内的其他目标上」
    // 顺序：放在嘲讽之后（嘲讽是"强制转移"，挑拨是"被指定时的被动偏转"，嘲讽优先）；
    //       22240 清净天眼 / skillTargetLocked 已在前面 return，天然压过本段。
    // 「范围内」取主目标所在单体范围——即同一敌方阵营内除主目标外的存活者（官方无更细几何定义）。
    if (main && main.side !== side && main.talent === 20530 && !(actor && actor.skillTargetLocked)) {
      const others = foes.filter(u => u && u.hp > 0 && u.id !== main.id);
      if (others.length > 0) {
        return [others[Math.floor(Math.random() * others.length)]];
      }
    }
    return main && main.side !== side ? [main] : foes.slice(0, 1);
  }
  // 未登记的 effType：按单体敌方兜底（与旧实现一致）
  if (actor && actor.tauntedBy && actor.talent !== 21840 && actor.talent !== 21240 && !actor.skillTargetLocked) {
    const taunter = foes.find(u => u.id === actor.tauntedBy);
    if (taunter) return [taunter];
  }
  return main && main.side !== side ? [main] : foes.slice(0, 1);
}

// 客户端 select_list[].type（brief_pos = (x+500)*1000+(y+500)）→ 目标单位。
// pool 必须与技能阵营一致：辅助/治疗传己方池，攻击传敌方池。
// ⚠️ 2026-11-08 修复：map_fight 手动选目标旧实现**只**在 aliveEnemies() 里找，单体辅助/治疗
//    选己方目标必然落空 → 回落"血量比例最低队友"，表现为"选了 A 却加到 B 身上"。
function resolveTargetPos(pool, briefPos) {
  const bp = Number(briefPos) || 0;
  if (!bp) return null;
  const tx = Math.floor(bp / 1000) - 500;
  const ty = (bp % 1000) - 500;
  const list = (pool || []).filter(u => u && u.hp > 0 && Array.isArray(u.pos));
  // 精确格优先；再做一次镜像兜底（客户端 isRightSide 时 x 取反）
  return list.find(u => u.pos[0] === tx && u.pos[1] === ty)
      || list.find(u => Math.abs(u.pos[0]) === Math.abs(tx) && u.pos[1] === ty)
      || null;
}

// 自动选技（findBestSkill 镜像 + 三百零二 B1 增强）：
// 1) 紧急治疗：有队友 hp<40% 且有可用纯治疗技 → 奶血量比例最低者（EFF_FRIEND_SELF 只奶自己且需自身<40%）
//    ——官方口径（findBestSkill slot7）原样保留。
// 2) 斩杀机会：任一（可用攻击技×候选主目标）组合存在"预估伤害 ≥ 目标血量"→ 跳过辅助/机会治疗，
//    直接攻击评估（先杀后辅）。
// 3) 增益/减益/控制：进攻型自身增益（101 物攻/102 魔攻）血量>50% 才开；防御型（103 物防/104 魔防/105 速度）
//    血量>25% 即开（挨打时最需要——旧 50% 一刀切会把残血防御技锁死）；减益技（target 方向负 delta，如威压）
//    目标属性未压满（> -2）即施放——旧实现从不放这类技；buffId 类 self/foe 方向分别查自身/全部敌方。
// 4) 机会治疗：己方 <65% 且本次奶量 < 缺口（无溢出浪费）且无斩杀机会 → 先奶。
// 5) 攻击评估：bestAttackChoice B1 尺（含防御/等级项，min(伤害,血量) 封顶，斩杀 ×1.8，克制 ×1.1）。
// 返回 {skillId, main}；无可用技能回落本属性魔法箭。
// ⚠️ 确定性契约：本函数无随机——map_fight 意图复算依赖"同一状态必同结果"（map_fight.js:2043 注释）。
//    （targetsOfEff 内 20760/20530 的随机目标改写是既有行为，非本函数引入。）
// 三百零二 B1 可用技过滤器（aiChoose / aiChooseDeep 共用一把尺，防两处分叉）：
// 凝视（10269）锁定技除外 × 心灵暗示（10003）只许被锁技 × 天击（10261）禁攻击技
function aiUsableList(unit) {
  return (unit.skills || []).filter(s => s.pp > 0 && aiUsable(skillCfg(s.id))
    // 10323 永恒解脱：解脱状态只能使用辅助技能
    && (!unit.eternalReleased || (() => { const c = skillCfg(s.id); return c && !((c.type === 1 || c.type === 2) && c.power > 0); })())
    && !((unit.gazeRounds || 0) > 0 && Number(s.id) === Number(unit.gazeSkillId))
    && (!(unit.mindShackleCount > 0) || (unit.mindShackleSkillId != null && Number(s.id) === Number(unit.mindShackleSkillId)))
    && (!((unit.noAttackRounds || 0) > 0) || !((c => c && (Number(c.type) === 1 || Number(c.type) === 2) && Number(c.power) > 0)(skillCfg(s.id)))));
}

function aiChoose(unit, units) {
  const side = unit.side;
  const friends = units.filter(u => u.hp > 0 && u.side === side);
  const foes = units.filter(u => u.hp > 0 && u.side !== side);
  const usable = aiUsableList(unit);
  const candidateFoes = (unit.tauntedBy && foes.find(u => u.id === unit.tauntedBy)) ? [foes.find(u => u.id === unit.tauntedBy)] : foes;

  // —— 治疗（纯治疗技；复合攻击技如天之甘露不是治疗技，走下方攻击评估）——
  const healAmtOf = (c, t) => Math.ceil(t.maxHp * (Number(c.healPct) || 0) / 100);
  // needRatio：血量比例低于此才考虑奶；avoidOverflow：机会治疗要求"奶量 < 缺口"（奶不满不溢出才值得花一回合）
  const pickHeal = (needRatio, avoidOverflow) => {
    for (const s of usable) {
      const c = skillCfg(s.id);
      if (!c || !c.healPct || c.power > 0) continue;
      const self = Number(c.effType) === 2001;
      const pool = self ? [unit] : friends;
      let main = null, worst = 2;
      pool.forEach(f => { const r = f.hp / f.maxHp; if (r < worst) { worst = r; main = f; } });
      if (!main || worst >= needRatio) continue;
      if (avoidOverflow && healAmtOf(c, main) >= main.maxHp - main.hp) continue; // 会溢出 → 不奶
      return { skillId: s.id, main };
    }
    return null;
  };
  const heal = pickHeal(0.4, false); // 紧急治疗（官方 40% 口径，无条件优先）
  if (heal) return heal;

  const hasKill = killShotExists(unit, units, usable, candidateFoes);

  // —— 增益/减益/控制（有斩杀机会时让位：先杀后辅）——
  if (!hasKill) {
    const buffSkill = usable.find(s => {
      const c = skillCfg(s.id);
      if (!c || c.type !== 3) return false;
      const rule = getSkillRule(c.id);
      if (!rule) return false;
      // 自身增益技：按 prop 分型——进攻型（101/102）血量>50%；防御型（103/104/105）血量>25%
      //（挨打时最需要防御增益——旧 50% 一刀切会把残血防御技锁死）；未达 +2 的属性才值得再开
      if (rule.statChanges) {
        const selfBuffs = rule.statChanges.filter(sc => sc.target === 'self' && sc.delta > 0);
        for (const sc of selfBuffs) {
          const curLv = (unit.statLevels && unit.statLevels[sc.prop]) || 0;
          if (curLv >= 2) continue;
          const offensive = sc.prop === 101 || sc.prop === 102;
          if (unit.hp > unit.maxHp * (offensive ? 0.5 : 0.25)) return true;
        }
        // 减益技（威压/破防类：target 方向负 delta）——三百零二新模型，旧实现从不施放这类技：
        // 任一敌方对应属性未压满（> -2）即候选。正 delta 的 target 方向（恩赐转移等复杂语义）不自动放。
        const debuffs = rule.statChanges.filter(sc => sc.target === 'target' && sc.delta < 0);
        if (debuffs.length && foes.some(f => ((f.statLevels && f.statLevels[debuffs[0].prop]) || 0) > -2)) return true;
      }
      // buffId 类（心神凝聚等）：self 方向查自身、foe 方向查全部敌方（旧实现拿 self buffId 查 foes[0]，碰巧能跑）
      if (rule.buffs && rule.buffs.length) {
        const b = rule.buffs[0];
        if (b.target === 'foe') {
          if (foes.some(f => !f.buffs || !f.buffs[b.buffId])) return true;
        } else if (!unit.buffs || !unit.buffs[b.buffId]) return true;
      }
      return false;
    });
    if (buffSkill) {
      const c = skillCfg(buffSkill.id);
      if (isFriendEff(c.effType)) return { skillId: buffSkill.id, main: unit };
      // 减益/控制目标：敌方中攻击最高者（V8 sort 稳定，同攻保持原序 ⇒ 确定性）
      const main = foes.slice().sort((x, y) =>
        ((y.attrs.phy_atk + y.attrs.mag_atk) - (x.attrs.phy_atk + x.attrs.mag_atk)))[0] || foes[0] || null;
      return { skillId: buffSkill.id, main };
    }

    // —— 机会治疗（<65% 且奶不满（无溢出）；hasKill 已在上游让位）——
    const heal2 = pickHeal(0.65, true);
    if (heal2) return heal2;
  }

  // —— 攻击评估（B1 尺）——
  const best = bestAttackChoice(unit, units, usable, candidateFoes);
  if (best) return best;
  // 天击（10261，批次H3）：攻击技被封锁时，兜底箭（MAGIC_ARROW 是攻击技）改为可用集内的辅助技，
  // 否则封锁被 fallback 绕过；可用集为空才放行兜底箭（宁可空放）。
  if ((unit.noAttackRounds || 0) > 0 && usable.length > 0) {
    const sup = usable[0];
    const supCfg = skillCfg(sup.id);
    let supMain = null;
    if (isFriendEff(supCfg.effType)) {
      let ratio = 2;
      friends.forEach(f => { const r = f.hp / f.maxHp; if (r < ratio) { ratio = r; supMain = f; } });
      supMain = supMain || unit;
    } else {
      supMain = foes[0] || null;
    }
    return { skillId: sup.id, main: supMain };
  }
  const arrow = MAGIC_ARROW[unit.nature] || 10018;
  return { skillId: arrow, main: foes[0] || null };
}

// 三百零二 B1 轻量伤害预估：与 settleSkill 主式同构（lvTerm × power×atk/def × 同属性 × 克制 × 期望 roll 0.9），
// 不含 roll 浮动/暴击/天赋/圣器链——排序与斩杀判定的确定性尺。斩杀判定需要绝对值 ⇒ 保留 lvTerm。
// 预估略保守（0.9 = roll 期望 0.925 的圆整），宁可少判斩杀也不虚报。
function estDamageOf(unit, cfg, foe) {
  if (!cfg || Number(cfg.type) === 3 || !(cfg.power > 0)) return 0;
  if (!foe || foe.hp <= 0 || foe.side === unit.side) return 0; // 己方向目标不计伤害（复合技的奶段不参与）
  const atkLv = Number(cfg.type) === 1
    ? ((unit.statLevels && unit.statLevels[101]) != null ? unit.statLevels[101] : (unit.phy_atk_lv || 0))
    : ((unit.statLevels && unit.statLevels[102]) != null ? unit.statLevels[102] : (unit.mag_atk_lv || 0));
  const defLv = Number(cfg.type) === 1
    ? ((foe.statLevels && foe.statLevels[103]) != null ? foe.statLevels[103] : (foe.phy_def_lv || 0))
    : ((foe.statLevels && foe.statLevels[104]) != null ? foe.statLevels[104] : (foe.mag_def_lv || 0));
  const atk = (Number(cfg.type) === 1 ? unit.attrs.phy_atk : unit.attrs.mag_atk) * attrLvMul(atkLv);
  const def = Math.max(1, (Number(cfg.type) === 1 ? foe.attrs.phy_def : foe.attrs.mag_def) * attrLvMul(defLv));
  const hasLightBonus = (cfg.nature === 5 && (unit.talent === 20630 || unit.talent === 21730));
  const hasNyarlathotepBonus = (unit.talent === 21900);
  const same = (cfg.nature === unit.nature || hasLightBonus || hasNyarlathotepBonus) ? 1.5 : 1;
  const lvTerm = ((Number(unit.level) || 1) + 5) / 50;
  return Math.max(1, Math.round(lvTerm * (cfg.power * atk) / def * same * naturePer(natureRelate(cfg.nature, foe.nature)) * 0.9));
}

// 三百零二 B1 斩杀机会探测：任一（可用攻击技 × 候选主目标）组合里存在
// "对某目标的预估伤害 ≥ 其当前血量"即 true。治疗机会/辅助决策让位于斩杀（先杀后辅）。
function killShotExists(unit, units, skills, candidateFoes) {
  const side = unit.side;
  return (skills || []).some(s => {
    const c = skillCfg(s.id);
    if (!c || Number(c.type) === 3) return false;
    return (candidateFoes || []).some(foe => {
      const ts = targetsOfEff(c.effType, side, units, foe, unit, c.id);
      return ts.some(t => estDamageOf(unit, c, t) >= t.hp);
    });
  });
}

// 攻击技评分（aiChoose 尾段抽取，作战策略各档共用同一把尺）：
// 三百零二 B1 重构——旧尺 Σ(power×atk×同属性×克制) 不看防御、不看斩杀、不封溢出，箭与真技的差距
// 被高防目标拉平。新尺逐目标：estDamageOf（含防御/等级项）；min(伤害, 目标血量) 封顶防溢出浪费；
// 斩杀组合（伤害 ≥ 目标血量）整组 ×1.8（少打一人的轮次收益）；克制主目标 ×1.1 保留（findBestAct WEEK 档优先）。
// 返回 {skillId, main}；无可评估组合 → null。纯辅助（type 3）不参与。
function bestAttackChoice(unit, units, skills, candidateFoes) {
  let best = null, bestScore = -1;
  const side = unit.side;
  (skills || []).forEach(s => {
    const c = skillCfg(s.id);
    if (!c || c.type === 3) return; // 纯辅助不参与伤害评估
    (candidateFoes || []).forEach(foe => {
      const rel = natureRelate(c.nature, foe.nature);
      const ts = targetsOfEff(c.effType, side, units, foe, unit, c.id);
      let sum = 0, anyKill = false;
      ts.forEach(t => {
        const dmg = estDamageOf(unit, c, t);
        if (dmg >= t.hp) { sum += t.hp; anyKill = true; } // 斩杀：贡献封顶目标血量并整组加权
        else sum += dmg;                                  // 溢出封顶：对残血目标多打的部分不计分
      });
      const score = sum * (anyKill ? 1.8 : 1) * (rel === 1 ? 1.1 : 1);
      if (score > bestScore) { bestScore = score; best = { skillId: s.id, main: foe }; }
    });
  });
  return best;
}

// 指定技能的目标解析（自行循环用；与 aiChoose 同款语义，但玩家钦点的技能不再做"是否值得放"判定）：
// 纯治疗 → effType 2001 自身 / 其余血量比最低队友；增益（己方向）→ 自身；攻击 → 全敌评分取最优。
function choiceForSkill(unit, units, skillId) {
  const c = skillCfg(skillId);
  if (!c) return null;
  const side = unit.side;
  const friends = units.filter(u => u.hp > 0 && u.side === side);
  const foes = units.filter(u => u.hp > 0 && u.side !== side);
  if (c.healPct && !(c.power > 0)) {
    let main = null;
    if (Number(c.effType) === 2001) main = unit;
    else {
      let ratio = 2;
      friends.forEach(f => { const r = f.hp / f.maxHp; if (r < ratio) { ratio = r; main = f; } });
    }
    return { skillId, main };
  }
  if (isFriendEff(c.effType)) return { skillId, main: unit };
  const lockTaunter = (unit.tauntedBy && foes.find(u => u.id === unit.tauntedBy)) || null;
  const pick = bestAttackChoice(unit, units, [{ id: skillId, pp: 1 }], lockTaunter ? [lockTaunter] : foes);
  if (pick) return pick;
  return { skillId, main: foes[0] || null };
}

// ===================== 三百零三 B2 期望树搜索（实验开关 PS_AI_SEARCH=1/2；默认 0=纯贪心 B1） =====================
// 收益调查与性能预算见 调研-自动战斗AI与魔法箭.md §七。设计要点：
//   转移模型 = 真 settleSkill/applySkillEffects 在**克隆阵型**上跑（零真身突变）；
//   确定性 = 每分支固定种子 mulberry32（同状态必同结果，不触碰 Math.random——map_fight 意图复算契约）；
//   候选集 = 贪心首选（保底，含治疗/增益语义） + 攻击技×候选主目标（≤14 枚举，去重）；
//   评估 = Σ存活(我方 (hp+shield)/maxHp) − Σ存活(敌方 …) + 击杀威胁度信用（死人按攻击面板/4000，上限 0.3）；
//   depth1 = 我动作 → 全部存活敌按速度序贪心回应 → 评估；
//   depth2 = 再加一层存活我方贪心回应 → 评估（队友本回合后续行动的协调预演）；
//   ⚠️ 只接三战线**实际决策点**（map_fight/tower_fight/dream 的 autoChoose）——意图复算
//   （map_fight 2048/2068）与优先度预测（applySkillPriorities）必须保持 aiChoose depth0，
//   否则每回合 36+ 次搜索 ≈ 430ms/回合（B2 性能预算红线）。
//   近似项（有意为之）：敌回应不扣怒气（幻梦 shadow 进来的怒气技在 sim 里免费，评估略保守）；
//   PP 不在分支内扣减（同分支单动作不构成经济）；simSt 浅拷贝（天气/元素状态变化不回写真身）。
// 搜索克隆：逐字段一层深拷贝（对象 → 浅拷贝、数组 → 元素浅拷贝、标量 → 直拷）。
// settleSkill/applySkillEffects 会往单位上 push 各类数组（hitByServants/attackedWaterAllies…）
// 并写 buffs/statLevels——漏一类就是真身突变（首版漏了数组字段，冒烟 F4 抓住）。
// 只读大引用（存档 brief/圣器词条）共享不拷：battle 代码对其只读。
const SEARCH_SHARED_REF_FIELDS = new Set(['servant', 'relicMisc', 'relicHurtByWeek', 'relicDeathSave', 'relicLowHpHeal', 'relicCure', 'slotEff']);
function cloneForSearch(u) {
  const c = {};
  for (const k of Object.keys(u)) {
    if (SEARCH_SHARED_REF_FIELDS.has(k)) { c[k] = u[k]; continue; }
    const v = u[k];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) c[k] = v.map(x => (x && typeof x === 'object') ? Object.assign({}, x) : x);
      else c[k] = Object.assign({}, v);
    } else c[k] = v;
  }
  return c;
}
function cloneUnitsForSearch(units) { return (units || []).map(u => (u && typeof u === 'object') ? cloneForSearch(u) : u); }
// 固定种子确定性 rng（mulberry32）：每个分支独立实例 ⇒ 枚举顺序无关、同状态必同结果
function searchRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 在克隆阵型上模拟一次真实施放（镜像 resolveRound 的目标解析与回退），返回是否成功结算
function searchSimAction(actor, choice, units, st, seed) {
  const cfg = skillCfg(choice.skillId);
  if (!cfg) return false;
  const friendEff = isFriendEff(cfg.effType);
  let targets = [];
  if (choice.main && choice.main.hp > 0) targets = targetsOfEff(cfg.effType, actor.side, units, choice.main, actor, cfg.id);
  targets = (targets || []).filter(t => t && t.hp > 0 && (friendEff ? t.side === actor.side : t.side !== actor.side));
  if (!targets.length) targets = friendEff ? [actor] : (choice.main ? [choice.main] : []);
  if (!targets.length) return false;
  try {
    const simSt = Object.assign({}, st || {}); // 浅拷贝：写盘进副本，数组/对象共享只读
    settleSkill(actor, cfg, targets, units, searchRng(seed), 0, simSt);
    applySkillEffects(actor, cfg, targets, units, 0, simSt);
  } catch (_) { return false; }
  return true;
}
// 评估函数：归一化血量比（死亡按 0 ⇒ 击杀天然拿满额移除信用）+ 死人威胁度（攻击面板/4000，上限 0.3——
// 杀掉高威胁单位的额外价值；dead set 在各分支间不同 ⇒ 逐分支可比，绝对偏移对全分支一致）
function evaluateBoardOf(units, side) {
  let mine = 0, theirs = 0, killThreat = 0, loseThreat = 0;
  for (const u of units) {
    if (!u || !u.attrs) continue;
    const frac = u.hp > 0 ? Math.min(1, (u.hp + Math.max(0, u.shield || 0)) / Math.max(1, u.maxHp)) : 0;
    if (u.side === side) mine += frac; else theirs += frac;
    if (u.hp <= 0) {
      const t = Math.min(0.3, ((u.attrs.phy_atk || 0) + (u.attrs.mag_atk || 0)) / 4000);
      if (u.side === side) loseThreat += t; else killThreat += t;
    }
  }
  return mine - theirs + killThreat - loseThreat;
}
// 期望树搜索主体。返回 {skillId, main}（形状与 aiChoose 完全一致）；候选全失败 → 贪心首选 → null。
function aiChooseDeep(unit, units, opts = {}) {
  const depth = Math.max(1, Math.min(2, Number(opts.depth) || 1));
  const side = unit.side;
  const st = opts.battleState || { round: 1 };
  const foes = units.filter(u => u.hp > 0 && u.side !== side);
  if (!foes.length) return aiChoose(unit, units);
  const usable = aiUsableList(unit);
  const candidateFoes = (unit.tauntedBy && foes.find(u => u.id === unit.tauntedBy)) ? [foes.find(u => u.id === unit.tauntedBy)] : foes;
  // 候选：贪心首选保底 + 攻击技×主目标枚举
  const cands = [];
  const greedy = aiChoose(unit, units);
  if (greedy && greedy.skillId) cands.push(greedy);
  usable.forEach(s => {
    const c = skillCfg(s.id);
    if (!c || Number(c.type) === 3) return;
    candidateFoes.forEach(foe => cands.push({ skillId: s.id, main: foe }));
  });
  const seen = new Set();
  const uniq = cands.filter(ch => {
    const k = ch.skillId + ':' + (ch.main ? ch.main.id : 0);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 14);
  if (uniq.length <= 1) return greedy;
  const oppSpeedOrder = list => list.slice().sort((a, b) => ((b.attrs && b.attrs.speed) || 0) - ((a.attrs && a.attrs.speed) || 0));
  let best = null, bestVal = -Infinity;
  for (const cand of uniq) {
    const u1 = cloneUnitsForSearch(units);
    const a1 = u1.find(x => x && x.id === unit.id);
    if (!a1 || a1.hp <= 0) continue;
    const m1 = cand.main ? u1.find(x => x && x.id === cand.main.id && x.hp > 0) : null;
    if (!searchSimAction(a1, { skillId: cand.skillId, main: m1 }, u1, st, 0x9E3779B9)) continue;
    // depth1：全部存活敌按速度序贪心回应
    for (const oa of oppSpeedOrder(u1.filter(x => x && x.hp > 0 && x.side !== side))) {
      const oc = aiChoose(oa, u1);
      if (oc && oc.skillId) searchSimAction(oa, oc, u1, st, 0x85EBCA6B);
    }
    if (depth >= 2) {
      // depth2：存活我方贪心回应（队友本回合后续行动的协调预演）
      for (const fa of oppSpeedOrder(u1.filter(x => x && x.hp > 0 && x.side === side && x.id !== unit.id))) {
        const fc = aiChoose(fa, u1);
        if (fc && fc.skillId) searchSimAction(fa, fc, u1, st, 0xC2B2AE3D);
      }
    }
    const val = evaluateBoardOf(u1, side);
    if (val > bestVal) { bestVal = val; best = cand; }
  }
  return best || greedy;
}
// 三战线实际决策点统一入口（map_fight/tower_fight/dream）。env PS_AI_SEARCH：0/缺省=纯贪心 B1，
// 1/2=期望树深度。我方作战策略模式（自行/单体/群体）优先于搜索（玩家钦点语义不覆盖）。
// 最优策略档（modeId 4 value 0）与敌方吃搜索（敌我同尺，三百零二原则）。
function autoChoose(actor, units, opts = {}) {
  if (!actor) return null;
  const mode = Number(process.env.PS_AI_SEARCH) || 0;
  const allyCtx = opts.allyCtx;
  if (actor.side === 0 && allyCtx && (allyCtx.modeId === 6 || (allyCtx.modeId === 4 && allyCtx.modeValue > 0))) {
    return allyChoose(actor, units, allyCtx);
  }
  if (mode >= 1) {
    return aiChooseDeep(actor, units, { depth: Math.min(mode, 2), battleState: opts.battleState });
  }
  return actor.side === 0 ? allyChoose(actor, units, allyCtx || {}) : aiChoose(actor, units);
}
// ===================== B2 结束 =====================

// 作战策略我方选技（m_servant_ai_* 的战斗消费入口，map_fight/tower_fight/dream 三条战线共用）：
// aiCtx = {modeId, modeValue}（handlers/skill_choice.aiCtxOf；undefined = 未配置 → 最优策略原行为）。
// 客户端 autoSelSkill 对每个我方单位固定发 val=0 —— 策略计算全在服务端，这里就是「作战策略」的实战语义：
//   modeId 6 自行：actor.aiSkills（誓灵存档 ai_skills，进场时由构建器带出）按序取第一个
//                  池内且 pp>0 且 aiUsable 的技能（优先级列表，非轮转指针——不空放冷却技）；
//                  空/全不可用 → aiChoose 兜底（不打空过）。
//   modeId 4 value 1 单体至上：单体攻击技只打一个锁定目标（actor._aiLock；死了才换下一个；
//                  首锁 = 最优策略会选的主目标）。单体技 pp 耗尽 → aiChoose（文案"用完单体技才会用其他技能"）。
//   modeId 4 value 2 群体优先：存活敌 ≥2 时只从群体技（全体/一排/直线）里选评分最高；
//                  无可用群体技 → aiChoose 兜底（严格照文案会空过整回合，绝大多数誓灵根本没有群攻技）。
//   modeId 4 value 0 最优策略：aiChoose 原行为（不动）。
// 手动选技（val>0）不走本函数——策略只在自动选技时介入。
function allyChoose(actor, units, aiCtx) {
  if (!actor) return null;
  const a = aiCtx || {};
  if (a.modeId !== 6 && !(a.modeId === 4 && a.modeValue > 0)) return aiChoose(actor, units);
  const usable = actor.skills.filter(s => s.pp > 0 && aiUsable(skillCfg(s.id))
    // 心灵暗示（10003）/天击（10261）同 aiChoose 口径（批次H3）：作战策略分支不得绕过
    && (!(actor.mindShackleCount > 0) || (actor.mindShackleSkillId != null && Number(s.id) === Number(actor.mindShackleSkillId)))
    && (!((actor.noAttackRounds || 0) > 0) || !((c => c && (Number(c.type) === 1 || Number(c.type) === 2) && Number(c.power) > 0)(skillCfg(s.id)))));
  const foes = units.filter(u => u.hp > 0 && u.side !== actor.side);
  const lockTaunter = (actor.tauntedBy && foes.find(u => u.id === actor.tauntedBy)) || null;
  if (a.modeId === 6) {
    const cycle = Array.isArray(actor.aiSkills) ? actor.aiSkills : [];
    for (const sid of cycle) {
      if (!sid || !usable.some(s => s.id === sid)) continue; // 空槽/不在池/无次数/不可用 → 顺延下一优先级
      const ch = choiceForSkill(actor, units, sid);
      if (ch) return ch;
    }
    return aiChoose(actor, units);
  }
  if (a.modeValue === 1) { // 单体至上
    const singles = usable.filter(s => {
      const c = skillCfg(s.id);
      return c && c.type !== 3 && !(c.healPct && !(c.power > 0)) && EFF_FOE_ONE.has(Number(c.effType) || 0);
    });
    let lock = (actor._aiLock != null && !lockTaunter) ? foes.find(u => u.id === actor._aiLock && u.hp > 0) : null;
    if (!lock && singles.length && foes.length) {
      const seed = aiChoose(actor, units); // 首锁：最优策略会打的主目标
      lock = seed && seed.main && seed.main.hp > 0 ? seed.main : foes[0];
    }
    if (singles.length && lock && lock.hp > 0) {
      if (lockTaunter) lock = lockTaunter; // 嘲讽改写目标优先于锁定（与 targetsOfEff 的 taunted 分支一致）
      actor._aiLock = lock.id;
      const pick = bestAttackChoice(actor, units, singles, [lock]);
      if (pick) return pick;
    }
    return aiChoose(actor, units);
  }
  // 群体优先（modeValue 2）
  if (foes.length >= 2) {
    const aoes = usable.filter(s => {
      const c = skillCfg(s.id);
      const e = Number(c && c.effType) || 0;
      return !!c && c.type !== 3 && (EFF_FOE_ALL.has(e) || EFF_FOE_ROW.has(e) || EFF_FOE_COL.has(e));
    });
    if (aoes.length) {
      const pick = bestAttackChoice(actor, units, aoes, lockTaunter ? [lockTaunter] : foes);
      if (pick) return pick;
    }
  }
  return aiChoose(actor, units);
}

// 伤害/治疗结算。返回 p_fight 条目 + 是否死亡
// extra 位掩码（与客户端 FightConst.lua / FightUtil.lua 1-based 索引 100% 对齐：值 = 1 << (INDEX - 1)）：
// Index 1: FIGHT_EXTRA_INDEX_MISS    = 1 -> 1 << 0 = 1
// Index 2: FIGHT_EXTRA_INDEX_CRIT    = 2 -> 1 << 1 = 2
// Index 3: FIGHT_EXTRA_INDEX_FIT     = 3 -> 1 << 2 = 4
// Index 4: FIGHT_EXTRA_INDEX_WEEK    = 4 -> 1 << 3 = 8
// Index 5: FIGHT_EXTRA_INDEX_RESIST  = 5 -> 1 << 4 = 16
// Index 6: FIGHT_EXTRA_INDEX_DEF     = 6 -> 1 << 5 = 32
// Index 7: FIGHT_EXTRA_INDEX_PROTECT = 7 -> 1 << 6 = 64
const FIGHT_EXTRA = {
  MISS: 1,
  CRIT: 2,
  FIT: 4,
  WEEK: 8,
  RESIST: 16,
  DEF: 32,
  PROTECT: 64,
};

// 阵营 1:1（等级压制即真实体验，玩家升级解决）；防御系数 1（一章一发普攻约 1/3 血，官方节奏）
const CRIT_BASE = 0.05;

// 官方/通用能力等级阶梯暴击率转换（-6 ~ +6 阶段）
const CRIT_STAGE_RATES = {
  "-6": 0.0,
  "-5": 0.005,
  "-4": 0.01,
  "-3": 0.015,
  "-2": 0.025,
  "-1": 0.035,
  "0": 0.05,
  "1": 0.125,
  "2": 0.25,
  "3": 0.50,
  "4": 0.80,
  "5": 0.95,
  "6": 1.00,
};

function critRateOfStage(stage) {
  const s = Math.max(-6, Math.min(6, Math.round(Number(stage) || 0)));
  return CRIT_STAGE_RATES[String(s)] != null ? CRIT_STAGE_RATES[String(s)] : 0.05;
}

// 羁绊（feeling）战斗加成。**这两条只写在客户端羁绊面板的文案里，客户端不参与战斗计算**
// （bc/Modules/fight* 全目录不含 feeling 字符串，p_fight 只下发 hurt/final_hp）——
// 战斗是服务端算的，所以不在这里实现就等于"文案骗人"。口径照 ServantFeelVO_re.lua:56-62：
//   暴击率   + feeling * 0.05%
//   技能命中率 + (feeling-100) * 0.05%（仅 feeling>100，即已缔结灵契后才可能有）
// 只有我方誓灵有 feeling（敌方单位不带该字段 → 加成恒 0）
function feelCritBonus(unit) {
  return (Math.max(0, Number(unit && unit.feeling) || 0) * 0.05) / 100;
}
function feelHitBonus(unit) {
  return Math.max(0, (Number(unit && unit.feeling) || 0) - 100) * 0.05;
}
function settleSkill(actor, cfg, targets, allUnits, rng, actIndex, battleState) {
  const rnd = (typeof rng === 'function') ? rng : Math.random;
  const results = [];
  const wakeEffects = [];
  let tauntHitConsumed = false;
  let lifeReturnHandled = false;
  const phase = ((actIndex || 0) * 100) + 4;
  const currentRound = (battleState && battleState.round) || 1;
  let skillRule = getSkillRule(cfg.id);
  // replace 型专属：基础规则整段抑制（含 postDamageHeal / forceCrit / 伤害乘区），
  // 与 applySkillEffects 的 rule=null 同口径（见 ELEMENT_REPLACE_BASE）。
  if (skillRule && elementExclusiveOf(actor, cfg.id) && elementReplacesBase(actor, cfg.id)) skillRule = null;
  // 10391 奉献誓约：嘲讽者在场；若已阵亡则清掉吸引标记（避免行动被死目标吞掉）
  if (actor && actor.tauntedBy) {
    const tnt = (allUnits || []).find(u => u && Number(u.id) === Number(actor.tauntedBy));
    if (!tnt || tnt.hp <= 0) { actor.tauntedBy = null; actor.tauntRounds = 0; }
  }
  if (battleState && cfg && isSupportSkillCfg(cfg)) {
    battleState.supportUsedSide = battleState.supportUsedSide || {};
    battleState.supportUsedSide[actor.side] = true;
  }
  // 彩虹之神使（21590 伊里丝）：自身使用辅助技能时，本回合所受伤害减少30%（回合末清）
  if (actor && actor.talent === 21590 && cfg && isSupportSkillCfg(cfg)) {
    actor.irisMitActive = true;
  }
  // 「每次技能一次」的被动标记（如剑圣 21960 的扣血/全队魔攻）：settleSkill 一次行动调一次，
  // 但内部 targets.forEach 按命中目标重复执行，所以在这里按行动重置，段内用标记拦重复。
  if (actor) { actor.aquaSwordFired = false; actor.quartetStolen = false; actor.syaroPick = null; }

  // ── 犹格索托斯 10273「虚无爆发」：消耗当前所有虚空（幻梦战一半），每点虚空 +1.5% 伤害，满虚空才混乱 ──
  // 快照必须在消耗**之前**取：本击的伤害乘区（天赋 0.5%/点 + 技能 1.5%/点）与"满 100 才混乱"都读它，
  // 否则会出现"放大招反而比普通攻击弱"（虚空被提前清空 → 天赋增伤丢失）。
  // 快照同时是本字段的清理点：非 10273 技能一律置 null，防止连击/追击路径读到上一次的残留。
  const vbRule = (cfg && Number(cfg.id) === 10273) ? getSkillRule(10273) : null;
  const voidBurst = !!(vbRule && vbRule.voidBurst && actor && actor.void_energy != null);
  if (actor) {
    if (voidBurst) {
      actor.voidBurstSnapshot = Math.max(0, Math.min(100, Number(actor.void_energy) || 0));
      const vbKeep = (battleState && battleState.isDream) ? (Number(vbRule.voidBurst.dreamKeepRatio) || 0) : 0;
      actor.void_energy = Math.floor(actor.voidBurstSnapshot * vbKeep);
      actor.voidFullFired = false;   // 倾泻后允许重新"充满"
    } else {
      actor.voidBurstSnapshot = null;
    }
  }

  // ── 犹格·索托斯 10274「空间箭」：施放产生 15 点虚空；满虚空下使用 → 目标降 2 级物防魔防并消耗 50 点虚空 ──
  // 满空判定取**施放前**的 void_energy（desc 语序：先"满虚空下使用会…消耗50"，后"产生15"）——
  // 先扣后充：满 100 → 扣到 50 → +15 = 65；未满（如 90）→ 不扣，+15 充满并触发天赋。
  // "降防"不在这里直写：走 statChanges 规则的 requireVoidFullCast 门控（applySkillEffects 消费，
  //   复用 gainStat 的免疫/钳制/事件通道）；spaceArrowFullCast 对非 10274 施放一律复位，防连击残留。
  if (Number(cfg.id) === 10274 && actor) {
    const wasFull = (Number(actor.void_energy) || 0) >= 100;
    actor.spaceArrowFullCast = wasFull;
    if (wasFull) {
      actor.void_energy = Math.max(0, (Number(actor.void_energy) || 0) - 50);
      actor.voidFullFired = false; // 消耗后允许下一次充满重新触发 21910 天赋
    }
    chargeVoid(actor, 15, wakeEffects, phase, actor.id);
  } else if (actor) {
    actor.spaceArrowFullCast = false;
  }

  // 10244 神明启示：下次攻击必暴 + 爆伤提升 + 目标锁 —— 在「下一次攻击技」开始结算时装填并消费。
  // 装填必须在 targetsOfEff 之后（handler 先展开目标再进 settleSkill），skillTargetLocked 在此一并解除。
  let nextAttackCritArmed = false;
  let nextAttackCritDmgArmed = 0;
  if (actor && actor.nextAttackForceCrit && Number(cfg.power) > 0) {
    nextAttackCritArmed = true;
    nextAttackCritDmgArmed = Number(actor.nextAttackCritDmgUp) || 0.35;
    actor.nextAttackForceCrit = false;
    actor.nextAttackCritDmgUp = 0;
    actor.skillTargetLocked = false;
  }
  // 弱者的反击（10266）：使用后降低自身正向能力等级（最多4级，8 项属性全算），
  // 每降 1 级本次技能伤害 +30%。降级走 gainStat（钳制/免疫/事件统一），乘区本回合按行动一次性生效。
  if (actor) actor.selfDropDmgBonus = 0;
  // —— 批次H3 回合状态机（施放侧记账）——
  if (actor && cfg && cfg.id) {
    // 心灵暗示（10003）配套：目标侧"最后使用的技能"以本字段为准（三个 handler 共用）
    actor.lastUsedSkill = cfg.id;
    // 心灵暗示（10003）：被束缚者每行动一次消耗一次（延时追击/连发也计入，口径已注明）
    if ((actor.mindShackleCount || 0) > 0) actor.mindShackleCount--;
    // 聚力击（10117）：换用其他技能 = 中断，连击计数清零
    if (actor.focusStreakSkillId != null && Number(cfg.id) !== Number(actor.focusStreakSkillId)) {
      actor.focusStrikeStreak = 0;
      actor.focusStreakSkillId = null;
    }
  }
  if (actor && skillRule && skillRule.selfDropPositiveForDmg && Number(cfg.power) > 0) {
    const sd = skillRule.selfDropPositiveForDmg;
    let dropped = 0;
    for (const p of [101, 102, 103, 104, 105, 111, 113, 115]) {
      if (dropped >= sd.maxDrop) break;
      const lv = (actor.statLevels && actor.statLevels[p]) || 0;
      if (lv > 0) {
        const take = Math.min(lv, sd.maxDrop - dropped);
        gainStat(actor, p, -take, { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
        dropped += take;
      }
    }
    if (dropped > 0) actor.selfDropDmgBonus = 1 + sd.perLevel * dropped;
  }

  // 瑶姬（23040 镇水）：在场时敌方誓灵使用水属性辅助技能直接失败
  const yaojiFoePresent = (allUnits || []).some(u => u && u.hp > 0 && u.side !== actor.side && u.talent === 23040);
  if (yaojiFoePresent && Number(cfg.nature) === 1 && (Number(cfg.kind) === 3 || cfg.power === 0)) {
    results.wakeEffects = [];
    return results;
  }

    // 天气召唤技能（effType: 4001，如 10010 烈日召来、10011 暴雨召来等）
  if (Number(cfg.effType) === 4001) {
    const weatherId = (cfg.selEffType && cfg.selEffType >= 101 && cfg.selEffType <= 106) ? (cfg.selEffType - 100) : 0;
    // 气象石族（11002001~4 / 曼杰特 16002004 / 麦塞克泰特 16003004）：
    // CfgItems「携带者使用召唤X时，持续回合数变为8回合，且在X天气下所有技能伤害提高20%」。
    // 只在召唤的天气与石头匹配时生效（不同天气的石头不叠加）。
    const wsum = actor.relicMisc && actor.relicMisc.weatherSummon;
    const extended = !!(wsum && Number(wsum.nature) === Number(weatherId));
    results.weatherChange = {
      start_weather: weatherId,
      // 「持续回合数变为8回合」含当前回合 → end_round = currentRound + 7（原生 5 回合 = +5，
      // 与 checkEntranceWeather 的 currentRound+5 同口径）。
      weather_end_round: currentRound + (extended ? ((wsum.extendTo || 8) - 1) : 5),
    };
    results.wakeEffects = [];
    return results;
  }

  // 78. 普塔（21640 万物熔铸）：使用攻击技能前清空己方全部护盾，每清空1名增伤35%
  if (actor.talent === 21640 && Number(cfg.power) > 0) {
    let cleared = 0;
    (allUnits || []).forEach(u => {
      if (u && u.hp > 0 && u.side === actor.side && (Number(u.shield) || 0) > 0) {
        // 2026-10-27：清盾补 200001 负值增量，否则己方护盾条长期停在旧值
        const had = Math.round(u.shield);
        u.shield = 0;
        cleared++;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [u.id],
          src_type: 1, src_id: 21640, id: 21640, effect_phase: 2,
          change_type: 200001, change_value: [-had], remove_round: 0,
        });
      }
    });
    actor.ptahClearedCount = cleared;
  }

  // 赫菲斯托斯圣器共享与伊邪那岐进场天气
  applyRelicSharing(allUnits);
  checkEntranceWeather(allUnits, battleState, currentRound);

  // 当前战场天气（Weather System）
  const curWeather = (battleState && battleState.weather && battleState.weather.start_weather) || 0;

  // 队伍常驻光环增伤（Talents：普罗米修斯火伤+10%、八岐大蛇水伤+10%、蚩尤土伤+10%、伊登风伤+10%）
  let talentNatureDmgMul = 1.0;
  (allUnits || []).forEach(u => {
    if (u && u.hp > 0 && u.side === actor.side) {
      const rule = talentRuleOf(u.talent);
      if (rule && rule.triggerType === 'aura' && rule.natureBonus && rule.natureBonus[cfg.nature]) {
        talentNatureDmgMul += rule.natureBonus[cfg.nature];
      }
    }
  });

  // 阿波罗（23050 神圣开悟）：使用技能前随机提升攻击能力等级，数值为本回合全场已使用技能次数
  if (actor.talent === 23050 && actIndex > 0) {
    const k = Math.min(6, Math.max(0, actIndex || 0));
    if (k > 0) {
      const prop = rnd() < 0.5 ? 101 : 102;
      actor.statLevels = actor.statLevels || {};
      const oldLv = actor.statLevels[prop] || 0;
      const newLv = Math.max(-6, Math.min(6, oldLv + k));
      const delta = newLv - oldLv;
      actor.statLevels[prop] = newLv;
      const attrName = PROP_ATTR_NAMES[prop];
      if (attrName) actor[attrName] = newLv;
      if (delta > 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 23050,
          id: 23050,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, delta, newLv)],
          remove_round: 0,
        });
      }
    }
  }

  // 白（21820 完全解析）：使用延时类技能时，获得自身最大生命值 10% 的护盾
  if (actor.talent === 21820 && isDelaySkill(cfg.id)) {
    const maxHp = Number(actor.maxHp || (actor.attrs && actor.attrs.hp) || actor.hp) || 1000;
    const shieldVal = Math.max(1, Math.round(maxHp * 0.10));
    actor.shield = (Number(actor.shield) || 0) + shieldVal;
    wakeEffects.push({
      trigger_count: 0,
      atk_servant_id: actor.id,
      src_servant_id: actor.id,
      tar_servant_ids: [actor.id],
      src_type: 1, // FIGHT_EFF_FEATURE
      src_id: 21820,
      id: 21820,
      effect_phase: phase,
      change_type: 200001, // FIGHT_EFF_CHANGE_TYPE_SHIELD
      change_value: [shieldVal],
      remove_round: 0,
    });
  }

  // 奈亚拉托提普（21900 无貌之神）：使用伏行之混沌时进入伏行状态
  if (cfg.id === 10272) {
    actor.crawling = true;
  }

  const hadShieldBeforeAtk = (Number(actor.shield) > 0);
  let extraShieldDmg = 0;
  // 技能 10207（繁华之音）：扣除当前所有护盾值，造成伤害后会再对目标造成护盾值的伤害
  if (cfg.id === 10207 && actor.shield > 0) {
    extraShieldDmg = Number(actor.shield) || 0;
    actor.shield = 0;
    wakeEffects.push({
      trigger_count: 0,
      atk_servant_id: actor.id,
      src_servant_id: actor.id,
      tar_servant_ids: [actor.id],
      src_type: 1,
      src_id: 10207,
      id: 10207,
      effect_phase: phase,
      change_type: 200001, // FIGHT_EFF_CHANGE_TYPE_SHIELD
      change_value: [-extraShieldDmg],
      remove_round: 0,
    });
  }

  // 克塔亚特（22790 接触融合）：每回合敌方第一个单体技能强制以自身为目标
  // （skillTargetLocked = 元素版警觉射击 10331"目标不会被改变"的技能级豁免，与天赋 21840/21240 同位）
  if (targets && targets.length === 1 && targets[0].side !== actor.side && actor.talent !== 21840 && actor.talent !== 21240 && !actor.skillTargetLocked) {
    const cthylla = (allUnits || []).find(u => u && u.hp > 0 && u.side !== actor.side && u.talent === 22790 && u.cthyllaAttract);
    if (cthylla) {
      cthylla.cthyllaAttract = false;
      targets = [cthylla];
    }
  }

  // 常羲（23310 夜幕）：非夜幕天气下敌方释放的首个辅助技能转化为释放夜幕召来
  if (Number(cfg.type) === 3) {
    const enemySideChangxi = (allUnits || []).find(u => u && u.hp > 0 && u.side !== actor.side && u.talent === 23310 && u.changxiNightIntercept);
    if (enemySideChangxi) {
      enemySideChangxi.changxiNightIntercept = false;
      if (battleState) {
        battleState.weather = {
          start_weather: WEATHER_IDS.NIGHT,
          weather_end_round: currentRound + 5,
        };
      }
    }
  }

  // 神楽Mea & Meu（22810 & 22820）：全场任意誓灵使用技能叠财布
  (allUnits || []).filter(u => u && u.hp > 0 && (u.talent === 22810 || u.talent === 22820)).forEach(u => {
    u.walletLayers = (u.walletLayers || 0) + 1;
  });

  // 复合攻击技统计：本次行动实际造成的总伤害（含护盾吸收）与被伤害目标，
  // 供"造成伤害后回复/追加效果"规则（postDamageHeal/afterDamageDrain）使用
  let totalDealt = 0;
  const damagedTargets = [];
  // 技能结算中触发的"受击类"天赋演出（烤鸭反击、玉子烧护盾）：在按目标循环里产生，
  // 但要等主伤害结果入列之后再下发，否则客户端会先弹反击数字再弹主伤害。
  const talentAfterEffects = [];
  targets.forEach(t => {
    // 10391 奉献誓约：被吸引的敌方单体攻击命中提尔 → 消耗 1 次吸引；3 次耗尽后己方全体较高攻击 +1
    if (!tauntHitConsumed && actor && actor.side !== t.side && Number(cfg.power) > 0
        && (EFF_FOE_ONE.has(Number(cfg.effType)) || Number(cfg.effType) === 1007)
        && (Number(t.tauntHitsLeft) || 0) > 0) {
      t.tauntHitsLeft -= 1;
      tauntHitConsumed = true;
      if (t.tauntHitsLeft <= 0) {
        t.tauntHitsLeft = 0;
        (allUnits || []).forEach(u => {
          if (u && u.side !== t.side && Number(u.tauntedBy) === Number(t.id)) { u.tauntedBy = null; u.tauntRounds = 0; }
        });
        (allUnits || []).forEach(a => {
          if (!a || a.hp <= 0 || a.side !== t.side) return;
          // 不在此处直接加：敌方行动中的属性 effect 客户端不显示；挂起到本方回合末统一结算
          a.devotionAtkUpPending = (Number(a.devotionAtkUpPending) || 0) + 1;
        });
      }
    }
    let revivedHp = 0; // 救活类天赋（玉兔 22950）的复活生命；0=未触发
    if (!t || t.hp <= 0) return;
    // 10426 灵归：回复目标 25% 生命，其他己方获得一半（12.5%）。
    // 走 results（负 hurt=治疗）——目标满血时其他队友也必须回血且客户端要显示治疗数字。
    if (!lifeReturnHandled && skillRule && skillRule.lifeReturn) {
      lifeReturnHandled = true;
      const lr = skillRule.lifeReturn;
      const healOne = (u, pct) => {
        if (!u || u.hp <= 0) return;
        const before = u.hp;
        const heal = Math.max(1, Math.round((u.maxHp || 1) * Number(pct) / 100 * healReceivedMul(u) * healDealtMul(actor)));
        u.hp = Math.min(u.maxHp, u.hp + heal);
        const real = Math.round(u.hp) - Math.round(before);
        results.push({ target: u.id, hurt: -real, final_hp: u.hp, shield_hurt: 0, final_shield: Math.max(0, u.shield || 0), extra: 0 });
      };
      targets.forEach(u => healOne(u, lr.healPct || 25));
      (allUnits || []).forEach(a => {
        if (!a || a.hp <= 0 || a.side !== actor.side) return;
        if (targets.some(x => x && x.id === a.id)) return;
        healOne(a, lr.othersPct || 12.5);
      });
    }
    // 纯治疗技（power=0）：按目标最大生命百分比回复。
    // 带 healPct 的攻击技（天之甘露10412/蛋烧冲击10406/重生之风10218）不走此分支——
    // 旧实现在此提前 return 导致其目标（敌方）被"治疗"，伤害永不结算（2026-10-05 修复）。
    if (cfg.healPct && !(cfg.power > 0)) {
      const heal = Math.ceil((t.maxHp * cfg.healPct) / 100 * healReceivedMul(t) * healDealtMul(actor)); // 禁疗 ×0.25；攻方圣器回复量乘区
      const after = Math.min(t.maxHp, t.hp + heal);
      const overflow = heal - (after - t.hp);
      results.push({ target: t.id, hurt: -(after - t.hp), final_hp: after, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
      t.hp = after;
      if (overflow > 0 && skillRule && skillRule.overflowHealStat) {
        for (let i = 0; i < skillRule.overflowHealStat; i++) {
          gainStat(t, [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], 1,
            { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
        }
      }
      return;
    }
    // 纯辅助增益技能（power <= 0 且 type === 3），不走伤害与 MISS 流程
    if (cfg.power <= 0 && cfg.type === 3) {
      // 10426 已在本轮目标循环开头写入 results（负 hurt=治疗），此处不再追加 0 伤害条目
      if (!(skillRule && skillRule.lifeReturn)) {
        results.push({ target: t.id, hurt: 0, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
      }
      return;
    }

    // 结界盾（10004）：受方处于结界盾保护时，敌方群体技能伤害归零（不判命中、不触发受击类效果；
    // 10139 波动斩等 pierceAoeImmune 规则可穿透）。放在命中判定之前 ⇒ 整段攻击流程被跳过。
    if (Number(cfg.power) > 0 && (t.aoeImmuneRounds || 0) > 0 && isAoeEffType(cfg.effType) && !(skillRule && skillRule.pierceAoeImmune)) {
      results.push({ target: t.id, hurt: 0, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
      return;
    }
    // 绝对防御（10007，批次H2）：受方处于绝对防御时，敌方技能伤害归零（追加效果在 applySkillEffects 拦）。
    // round 门控防跨波次泄漏；10139 波动斩（穿透）与 10068/10140（破坏）可命中；DoT/回合末效果非"技能"，天然不受影响。
    if (t.absoluteDef && t.absoluteDefRound === currentRound && t.side !== actor.side
        && !(skillRule && (skillRule.pierceAbsoluteDef || skillRule.breakBarrier))) {
      results.push({ target: t.id, hurt: 0, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
      return;
    }

    // 天气对单次行动伤害与命中修正：
    let weatherDmgMul = 1.0;
    let weatherHitBonus = 0;
    let isWeatherSureHit = false;
    if (curWeather === WEATHER_IDS.SANDSTORM) {
      if (cfg.nature === 4) { weatherDmgMul *= 1.2; weatherHitBonus += 10; }
    } else if (curWeather === WEATHER_IDS.RAIN) {
      if (cfg.nature === 1) weatherDmgMul *= 1.2;
      if (cfg.nature === 2) weatherDmgMul *= 0.9;
      if (cfg.id === 10028) isWeatherSureHit = true; // 升天海流暴雨下必中
    } else if (curWeather === WEATHER_IDS.SUN) {
      if (cfg.nature === 2) weatherDmgMul *= 1.2;
      if (cfg.nature === 1) weatherDmgMul *= 0.9;
    } else if (curWeather === WEATHER_IDS.TURBULENCE) {
      if (cfg.nature === 3) weatherDmgMul *= 1.1;
      if (cfg.id === 10027) isWeatherSureHit = true; // 暴风雪乱流下必中
    } else if (curWeather === WEATHER_IDS.LIGHT) {
      if (cfg.nature === 5) weatherDmgMul *= 1.2;
      if (t.nature === 6) weatherDmgMul *= 1.2; // 圣光下暗系誓灵所受伤害 +20%
    } else if (curWeather === WEATHER_IDS.NIGHT) {
      if (cfg.nature === 6) weatherDmgMul *= 1.2;
      if (t.nature === 5 && t.talent !== 21490) weatherDmgMul *= 1.2; // 夜幕下光系誓灵所受伤害 +20%（星野梦美 21490 免受夜幕伤害）
    }
    // 旋风之镰（20180 镰鼬）：乱流天气时，自身风属性技能伤害翻倍
    if (actor.talent === 20180 && curWeather === WEATHER_IDS.TURBULENCE && Number(cfg.nature) === 3) {
      weatherDmgMul *= 2.0;
    }
    if (skillRule && skillRule.sureHitWeather != null && Number(skillRule.sureHitWeather) === Number(curWeather)) {
      isWeatherSureHit = true;
    }

    // 命中：hitRate（默认 100）受命中等级与目标回避等级分别修正
    // 夏色祭（21950 友情的力量！）：若目标本回合已被攻击过，无视正向闪避等级
    let effDodgeRateLv = (t.statLevels && t.statLevels[115]) != null ? t.statLevels[115] : (t.dodge_rate_lv || 0);
    if (actor.talent === 21950 && t.hitThisRound) {
      effDodgeRateLv = Math.min(0, effDodgeRateLv);
    }
    const dodge = (t.dodge || 0) * hitDodgeLvMul(effDodgeRateLv);
    const hitRateLv = (actor.statLevels && actor.statLevels[113]) != null ? actor.statLevels[113] : (actor.hit_rate_lv || 0);

    // 阿瑞斯（20640 不屈的战魂）：生命低于50%后，接下来每损失1%生命额外提升1%命中率
    let aresHitBonus = 0;
    if (actor.talent === 20640 && (actor.hp / actor.maxHp) < 0.5) {
      aresHitBonus = (0.5 - (actor.hp / actor.maxHp)) * 100;
    }

    // 千户 & 尤莉（22410 尤的同行者）：千户在场时，尤莉技能必定命中
    if (actor.type === 3242002 && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.type === 3245001)) {
      isWeatherSureHit = true;
    }

    // 海姆达尔（22120 克敌机先）：使用技能必定命中
    if (actor.talent === 22120) {
      isWeatherSureHit = true;
    }
    // 狩猎标记（10015，批次H3）：上回合对目标施放标记 → 本回合对目标必定命中
    if (actor.nextSureHitVs && actor.nextSureHitVs.round === currentRound && Number(actor.nextSureHitVs.targetId) === Number(t.id)) {
      isWeatherSureHit = true;
    }

    // 希芙（22680 金色流苏）：己方所有正向能力等级总和提升命中/暴击/爆伤
    let sifHitBonus = 0;
    let sifCritRateBonus = 0;
    let sifCritMulBonus = 0;
    if (actor.talent === 22680) {
      let posStages = 0;
      (allUnits || []).forEach(u => {
        if (u && u.hp > 0 && u.side === actor.side && u.statLevels) {
          [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
            const lv = u.statLevels[p] || 0;
            if (lv > 0) posStages += lv;
          });
        }
      });
      sifHitBonus = posStages * 1.5;
      sifCritRateBonus = posStages * 0.015;
      sifCritMulBonus = posStages * 0.015;
    }

    // 91. 金牛座（21080 影杀之蹄）：速度等级>=2 时攻击必定命中
    // 106. 申（22070 遇强则强）：敌方数量>=己方时技能必定命中
    let isForceHit = false;
    // 123. 迦楼罗（22730 琉璃心）：攻击中毒目标时必定命中
    if (actor.talent === 22730 && t.buffs && t.buffs[BUFF_IDS.POISON]) {
      isForceHit = true;
    }
    if (actor.talent === 21080 && ((actor.statLevels && actor.statLevels[105]) || 0) >= 2) {
      isForceHit = true;
    }
    if (actor.talent === 22070) {
      const foeCount = (allUnits || []).filter(x => x && x.hp > 0 && x.side !== actor.side).length;
      const allyCount = (allUnits || []).filter(x => x && x.hp > 0 && x.side === actor.side).length;
      if (foeCount >= allyCount) isForceHit = true;
    }

    // P3-B 专属改写（雪女暴风雪/燥热的阳炎）：唤醒期间该技能必定命中（不限天气）
    const elementExBeh = elementExclusiveBehavior(actor, cfg.id);

    // 命中：hitRate（默认 100）受命中等级与目标回避等级分别修正。
    // hitRate=0 是官方"命中—/无"语义（客户端 UI hitRate==0 显示"──"且不显示命中标签，
    // BWIKI 技能页命中栏同样显示"—"）＝不做命中检定必中，不是 0% 命中率——
    // 旧实现把 0 当 0% 导致惩戒/终结之刃/深渊狱火/绝地反击 100% miss（2026-10-05 修复）。
    // 陨石暴击（10121）：上一回合该技能未命中 → 本回合同技能必中（miss 时记 nextSureHit）。
    const missSureHit = !!(actor.nextSureHit && actor.nextSureHit.round === currentRound && actor.nextSureHit.skillId === cfg.id);
    const isSureHit = isWeatherSureHit || isForceHit || missSureHit || (elementExBeh && elementExBeh.sureHit) || Number(cfg.hitRate) === 0;
    // 圣器命中修正（百分点）：受击方幻象帽族「以其为目标的技能，命中率降低N%」→ relicDodgeBonus；
    // 攻击方乌加特之眼「攻击技能的命中率提升N%」→ relicHitBonus。两者直接加在命中率上（不是等级）。
    const relicDodgeDown = Number(t.relicDodgeBonus) || 0;
    const relicHitUp = Number(actor.relicHitBonus) || 0;
    // 刻刻帝（17005004 通用段）：辅助技能命中率 +10（百分点，仅辅助技）
    const relicAssistHit = (isSupportSkillCfg(cfg) && actor.relicMisc && actor.relicMisc.assistHitBonus) || 0;
    // 批次G-2 命中管线（二百五十六）：仅对"带命中率的辅助技"有意义
    // （154 条辅助技中 116 条 hitRate=0 = 官方"命中—"必中，代码里走 isSureHit，天然绕过本段）
    let talentAssistHitMul = 1.0;
    if (isSupportSkillCfg(cfg) && Number(cfg.hitRate) !== 0) {
      // 奇门遁甲（20440 玄女）：辅助类技能对其命中率下降 100%
      if (t.talent === 20440) talentAssistHitMul = 0;
      // 守护结界（20880 狛犬）：我方誓灵受到辅助技能的命中率减半
      if ((allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.talent === 20880)) talentAssistHitMul *= 0.5;
    }
    const hitChance = isSureHit
      ? 1.0
      : Math.max(0, Math.min(100,
          ((cfg.hitRate == null ? 100 : cfg.hitRate + weatherHitBonus + aresHitBonus + sifHitBonus) * hitDodgeLvMul(hitRateLv)
          + feelHitBonus(actor) + relicHitUp + relicAssistHit - relicDodgeDown) * talentAssistHitMul)) / 100;
    if (!isSureHit && (rnd() < dodge || rnd() > hitChance)) {
      // 陨石暴击（10121）：本回合未命中 → 下回合同技能必中（回合门控，过期自失效）
      if (skillRule && skillRule.sureHitAfterMiss) {
        actor.nextSureHit = { round: currentRound + 1, skillId: cfg.id };
      }
      // 聚力击（10117）：未命中重置连击
      if (skillRule && skillRule.powerDoublePerUse) {
        actor.focusStrikeStreak = 0;
        actor.focusStreakSkillId = null;
      }
      results.push({ target: t.id, hurt: 0, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: FIGHT_EXTRA.MISS }); // bit1 MISS (1)
      return;
    }

    // 保登心爱（22870 天然自来熟）：攻击时自身低于目标的能力等级与目标平分（向上取整）
    // desc 明确「多个目标时随机选人」——本段在 targets.forEach 内，必须锁定单个目标，
    // 否则群攻会把每个目标都平分一次（自身等级被反复拉高）。
    if (actor.talent === 22870) {
      if (actor.syaroPick == null) actor.syaroPick = Math.floor(Math.random() * targets.length);
      if (targets.indexOf(t) === actor.syaroPick) {
        actor.statLevels = actor.statLevels || {};
        t.statLevels = t.statLevels || {};
        [101, 102, 103, 104, 105, 111, 113, 115].forEach(prop => {
          const aLv = actor.statLevels[prop] || 0;
          const tLv = t.statLevels[prop] || 0;
          if (aLv < tLv) {
            const avgLv = Math.ceil((aLv + tLv) / 2);
            gainStat(actor, prop, avgLv - aLv, { effects: wakeEffects, srcId: 22870, phase });
          }
        });
      }
    }

    // 六维属性经能力等级（Stat Stages）倍率与女娲全员光环修正
    // 斯露德（22150 力量女武神）：负面防御能力等级反转为对应的正向攻击等级
    let sigrunAtkLvOverride = 0;
    if (actor.talent === 22150) {
      const negPhyDef = (actor.statLevels && actor.statLevels[103]) != null ? actor.statLevels[103] : (actor.phy_def_lv || 0);
      const negMagDef = (actor.statLevels && actor.statLevels[104]) != null ? actor.statLevels[104] : (actor.mag_def_lv || 0);
      if (cfg.type === 1 && negPhyDef < 0) sigrunAtkLvOverride = -negPhyDef;
      else if (cfg.type === 2 && negMagDef < 0) sigrunAtkLvOverride = -negMagDef;
    }

    let rawAtkLv = cfg.type === 1
      ? ((actor.statLevels && actor.statLevels[101]) != null ? actor.statLevels[101] : (actor.phy_atk_lv || 0))
      : ((actor.statLevels && actor.statLevels[102]) != null ? actor.statLevels[102] : (actor.mag_atk_lv || 0));
    // 神楽Meu（22820 清楚系主播）：被攻击时攻击方攻击能力等级视作0
    const atkLv = (t.talent === 22820) ? 0 : Math.max(rawAtkLv, sigrunAtkLvOverride);

    let defLv = cfg.type === 1
      ? ((t.statLevels && t.statLevels[103]) != null ? t.statLevels[103] : (t.phy_def_lv || 0))
      : ((t.statLevels && t.statLevels[104]) != null ? t.statLevels[104] : (t.mag_def_lv || 0));
    // 神楽Meu（22820 清楚系主播）：攻击时将目标正向能力等级视作负面
    if (actor.talent === 22820 && defLv > 0) {
      defLv = -defLv;
    }

            // 33. 瓦利（22140 复仇者）：无视击败过己方誓灵的敌人的正向防御与闪避能力等级
    if (actor.talent === 22140 && actor.valiRevengeAgainst === t.id) {
      defLv = Math.min(0, defLv);
    }

    // 罗刹（23150 魔道恶鬼）：目标物防 >= 2 时无视正向防御，介于 [-2, 2) 时将防御等级视作 -2
    if (actor.talent === 23150 && cfg.type === 1) {
      if (defLv >= 2) defLv = Math.min(0, defLv);
      else if (defLv >= -2) defLv = -2;
    }

// 布伦希尔德（20030 女武神之心）：攻击时无视目标所有正向的能力等级变化
    if (actor.talent === 20030) {
      defLv = Math.min(0, defLv);
    }

    // 夏色祭（21950 友情的力量！）：若目标本回合已被攻击过，无视正向防御等级
    if (actor.talent === 21950 && t.hitThisRound) {
      defLv = Math.min(0, defLv);
    }

    // P2 激昂战意（1242013）/ 涌动之拳（3021004）：下一次攻击无视物防等级提升
    if (actor.nextDefPierce) {
      defLv = Math.min(0, defLv);
      actor.nextDefPierce = false;
    }
    // P3-A 军刀突刺（10380 专属改写·3446003）：目标 3 回合内受到的伤害无视其正向防御等级
    if ((t.defPierceRounds || 0) > 0) {
      defLv = Math.min(0, defLv);
    }
    // 精灵之音（10187）：目标下次声音技伤害+50%，且该次攻击无视敌方的防御等级提升
    // （nextSoundBoost 稍后在声音段消费 dmg 并清空，此处只读；多段声音技只有首个目标吃到，与 dmg 同口径）
    if (isSoundSkill(cfg.id) && actor.nextSoundBoost && actor.nextSoundBoost.ignoreDefLvUp) {
      defLv = Math.min(0, defLv);
    }
    // 10243 天国复仇：无视「攻击过己方」的敌方誓灵的物防等级（desc 完成时态 ⇒ 战斗内累计口径，
    // 与瓦利 22140「击败过己方」同族；hitByServants 记录在受击者身上，判定 = 施术者一侧任一存活单位被 t 打过）。
    // ⚠️ 必须放在 `let def = ... * attrLvMul(defLv)`（下方防御乘区）之前——2997 的 P4 ignoreDefUp
    //    在 def 之后改 defLv 属既有死代码（本条不沿用那个位置）；defLv 此处已是 cfg.type 对应防档，只压正向。
    if (skillRule && skillRule.ignoreDefUpAttackedAlly && defLv > 0
        && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side
          && (u.hitByServants || []).some(h => Number(h.id) === Number(t.id)))) {
      defLv = Math.min(0, defLv);
    }

    // 古河渚（22310 光坂连结）：己方有存活古河渚且攻击方有盾时，攻击附加等量护盾攻击力
    let nagisaAtkBonus = 0;
    if (actor.shield > 0 && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22310)) {
      nagisaAtkBonus = Number(actor.shield) || 0;
    }

    // 尤莉与千户羁绊双子：
    let chitoYuuriAtkBonus = 0;
    if (actor.type === 3242002) { // 尤莉额外计算千户 50% 原始物攻
      const chito = (allUnits || []).find(u => u && u.hp > 0 && u.side === actor.side && u.type === 3245001);
      if (chito) chitoYuuriAtkBonus = (chito.attrs.phy_atk || 0) * 0.50;
    } else if (actor.type === 3245001) { // 千户额外计算尤莉 50% 原始魔攻
      const yuuri = (allUnits || []).find(u => u && u.hp > 0 && u.side === actor.side && u.type === 3242002);
      if (yuuri) chitoYuuriAtkBonus = (yuuri.attrs.mag_atk || 0) * 0.50;
    }

    let atk = ((cfg.type === 1 ? actor.attrs.phy_atk : actor.attrs.mag_atk) + nagisaAtkBonus + chitoYuuriAtkBonus) * attrLvMul(atkLv) * (hasNuwaAura(actor, allUnits) ? 1.15 : 1.0);
    // 芬里尔（20020 万神吞噬）：攻击目标时，将目标对应攻击额外补正在芬里尔攻击值内进行计算
    if (actor.talent === 20020) {
      const isMag = (cfg.type === 2);
      const foeAtk = isMag ? ((t.attrs ? t.attrs.mag_atk : (t.mag_atk || 0)) * attrLvMul((t.statLevels && t.statLevels[102]) || 0))
                           : ((t.attrs ? t.attrs.phy_atk : (t.phy_atk || 0)) * attrLvMul((t.statLevels && t.statLevels[101]) || 0));
      atk += Math.floor(foeAtk);
    }
    // 一之濑琴美（22350 平行世界）：攻击时计算自身较高攻击
    if (actor.talent === 22350) {
      const atkLvPhy = (actor.statLevels && actor.statLevels[101]) != null ? actor.statLevels[101] : (actor.phy_atk_lv || 0);
      const atkLvMag = (actor.statLevels && actor.statLevels[102]) != null ? actor.statLevels[102] : (actor.mag_atk_lv || 0);
      const pAtk = (actor.attrs.phy_atk + nagisaAtkBonus) * attrLvMul(atkLvPhy);
      const mAtk = (actor.attrs.mag_atk + nagisaAtkBonus) * attrLvMul(atkLvMag);
      atk = Math.max(pAtk, mAtk) * (hasNuwaAura(actor, allUnits) ? 1.15 : 1.0);
    }

    let def = (cfg.type === 1 ? t.attrs.phy_def : t.attrs.mag_def) * attrLvMul(defLv) * (hasNuwaAura(t, allUnits) ? 1.15 : 1.0);
    // 四合如意（17002004 通用段）：N% 概率以另一项防御参与计算（物攻打魔防 / 魔攻打物防）
    if (actor.relicMisc && actor.relicMisc.swapDef && rnd() < actor.relicMisc.swapDef.chance) {
      def = (cfg.type === 1 ? t.attrs.mag_def : t.attrs.phy_def) * attrLvMul(defLv) * (hasNuwaAura(t, allUnits) ? 1.15 : 1.0);
    }
    // 一之濑琴美（22350 平行世界）：被攻击时计算自身较高防御
    if (t.talent === 22350) {
      const defLvPhy = (t.statLevels && t.statLevels[103]) != null ? t.statLevels[103] : (t.phy_def_lv || 0);
      const defLvMag = (t.statLevels && t.statLevels[104]) != null ? t.statLevels[104] : (t.mag_def_lv || 0);
      const pDef = t.attrs.phy_def * attrLvMul(defLvPhy);
      const mDef = t.attrs.mag_def * attrLvMul(defLvMag);
      def = Math.max(pDef, mDef) * (hasNuwaAura(t, allUnits) ? 1.15 : 1.0);
    }
    // P3-A 心算（10378 专属改写·3442002）：4 回合内自身攻击取敌方较低防御
    if ((actor.mentalMathRounds || 0) > 0) {
      const lvP = Math.min(0, (t.statLevels && t.statLevels[103]) != null ? t.statLevels[103] : (t.phy_def_lv || 0));
      const lvM = Math.min(0, (t.statLevels && t.statLevels[104]) != null ? t.statLevels[104] : (t.mag_def_lv || 0));
      def = Math.min(t.attrs.phy_def * attrLvMul(lvP), t.attrs.mag_def * attrLvMul(lvM)) * (hasNuwaAura(t, allUnits) ? 1.15 : 1.0);
    }
    // P4 基础规则：取较低防御 / 无视防御等级提升（10171 等）
    if (skillRule && skillRule.ignoreDefUp) defLv = Math.min(0, defLv);
    if (skillRule && skillRule.lowerDef) {
      const lvP = Math.min(0, (t.statLevels && t.statLevels[103]) != null ? t.statLevels[103] : (t.phy_def_lv || 0));
      const lvM = Math.min(0, (t.statLevels && t.statLevels[104]) != null ? t.statLevels[104] : (t.mag_def_lv || 0));
      def = Math.min(t.attrs.phy_def * attrLvMul(lvP), t.attrs.mag_def * attrLvMul(lvM)) * (hasNuwaAura(t, allUnits) ? 1.15 : 1.0);
    }
    // P3-C 复仇风暴（10171 专属改写·1643004）：取防御方较低的一项防御
    if (cfg.id === 10171 && elementExclusiveOf(actor, cfg.id)) {
      const lvP = Math.min(0, (t.statLevels && t.statLevels[103]) != null ? t.statLevels[103] : (t.phy_def_lv || 0));
      const lvM = Math.min(0, (t.statLevels && t.statLevels[104]) != null ? t.statLevels[104] : (t.mag_def_lv || 0));
      def = Math.min(t.attrs.phy_def * attrLvMul(lvP), t.attrs.mag_def * attrLvMul(lvM)) * (hasNuwaAura(t, allUnits) ? 1.15 : 1.0);
    }
    const hasLightSameBonus = (cfg.nature === 5 && (actor.talent === 20630 || actor.talent === 21730 || actor.talent === 21700 || actor.talent === 21710 || actor.talent === 21720));
    const hasNyarlathotepSameBonus = (actor.talent === 21900);
    const hasSnowWhiteSameBonus = (actor.talent === 22740);
    const hasNuadaSameBonus = (actor.talent === 20720 && isPunchSkill(cfg.id));
    const hasChironSameBonus = (actor.talent === 20600); // 喀戎（20600 全知的贤者）
    const hasRaguelLightBonus = (actor.talent === 23230 && cfg.nature === 5); // 拉贵尔（23230 神之友）
    const hasSlimeAdaptBonus = (actor.talent === 20490); // 史莱喵（20490 万能适配者）
    // 天之甘露（10412）"拥有暗系加成"：暗系誓灵（苏摩）使用时视作同属性技能（CfgSkillDetail fightDesc）
    const hasDarkSameBonus = !!(skillRule && skillRule.darkSameBonus && actor.nature === 6);
    // 元素融合（10173）：使用后自身所有攻击技能都拥有本属性修正（批次H1）
    const fusionSame = !!(actor.fusionActive && Number(cfg.power) > 0 && cfg.type !== 3);
    const same = (cfg.nature === actor.nature || hasLightSameBonus || hasNyarlathotepSameBonus || hasSnowWhiteSameBonus || hasNuadaSameBonus || hasChironSameBonus || hasRaguelLightBonus || hasSlimeAdaptBonus || hasDarkSameBonus || fusionSame) ? 1.5 : 1;
    // 元素唤醒（CfgElement.mergeSkillInfo）：本属性攻击技能的本属性修正 **变为** 175%~200%
    // （不是再乘 1.5 —— 客户端文案"本属性攻击修正变为{1}%"）。由 map_fight 在单位上挂
    // element={lv,servantType,rounds,...}，rounds>0 表示唤醒生效中。
    const elAwake = elementAwakeOf(actor);
    let sameMul = same;
    if (elAwake && Number(cfg.nature) === Number(actor.nature)
        && (!Number(elAwake.servantType) || Number(elAwake.servantType) === Number(actor.type))) {
      sameMul = EL.strengthenOf(elAwake.lv)[1] / 100;
    }
    // 异兽变换（20330 奇美拉）：变为与自己使出的招式相同的属性
    // 语义落地：受击侧——被打时用"攻击技能属性 vs 自己当前属性"判克制，而自己的属性应等于
    // **上一次使用技能的属性**（chimeraNature）。用 effDefNature 代替 t.nature 参与 rel，
    // 不改 t.nature（面板/图鉴/其他判定不受影响）。
    const effDefNature = (t.talent === 20330 && t.chimeraNature != null) ? Number(t.chimeraNature) : t.nature;
    let rel = natureRelate(cfg.nature, effDefNature);
    // P4 基础规则：按目标属性改克制（10408）/ 同属性改克制（10362）
    if (skillRule && Array.isArray(skillRule.relOverrideNature) && skillRule.relOverrideNature.includes(Number(t.nature))) rel = 1;
    if (skillRule && skillRule.relOverrideSameNature && Number(cfg.nature) === Number(t.nature)) rel = 1;
    // 豆馅（17033004）：携带者「不会造成抵抗伤害」→ rel=2（抵抗）按无关系处理
    if (rel === 2 && actor.relicMisc && actor.relicMisc.noResistDamage) rel = 0;
    // 豆馅千夜专属：对与技能同属性的怪物造成克制伤害 → 同属性目标由抵抗改写为克制
    if (actor.relicMisc && actor.relicMisc.sameNatureWeek && Number(cfg.nature) === Number(t.nature)) rel = 1;
    // P3 抵抗姿态（10392/10396）：受方 stance 生效时改写克制关系
    if ((t.stanceRounds || 0) > 0) {
      if (t.stanceKind === 'resist_non_same') rel = (Number(cfg.nature) === Number(t.nature)) ? 1 : 2;
      else if (t.stanceKind === 'resist_same_enemy') { if (Number(cfg.nature) === Number(actor.nature)) rel = 2; }
    }

    // 提尔（22960 提尔之手）：自身免受属性克制
    if (t.talent === 22960 && rel === 1) {
      rel = 0;
    }

    // 兰斯洛特（23010 湖夜祈祷）：对水系之外誓灵造成克制，对水系伤害-20%
    let lancelotMul = 1.0;
    if (actor.talent === 23010) {
      if (t.nature !== 1) rel = 1;
      else lancelotMul = 0.80;
    }

    // 应龙-乾元（22930 真龙）：6层免克制，10层克制水土
    if (t.talent === 22930 && (t.trueDragonLayers || 0) >= 6 && rel === 1) {
      rel = 0;
    }
    if (actor.talent === 22930 && (actor.trueDragonLayers || 0) >= 10 && (t.nature === 1 || t.nature === 4)) {
      rel = 1;
    }

    // 63. 小红帽（22760 童话之心）：圣光/夜幕天气下自身对所有属性产生抵抗
    if (t.talent === 22760 && (curWeather === WEATHER_IDS.LIGHT || curWeather === WEATHER_IDS.NIGHT) && rel === 1) {
      rel = 2;
    }

    // 莎莉叶（22550 光暗交织）：对光暗属性誓灵造成克制，并能抵抗光暗属性技能
    if (actor.talent === 22550 && (t.nature === 5 || t.nature === 6)) {
      rel = 1;
    }
    if (t.talent === 22550 && (cfg.nature === 5 || cfg.nature === 6) && rel === 1) {
      rel = 2;
    }

    // 帕西瓦尔（23200 三城之力）：可对与己方场地角色属性相同的敌方角色造成克制伤害
    if (actor.talent === 23200 && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.nature === t.nature)) {
      rel = 1;
    }

    // 木俣神（22630 被遗弃之人）：己方场上只存在自身一个水系誓灵时，己方誓灵可对水与火属性伤害产生抵抗
    if ((allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 22630 &&
        (allUnits || []).filter(x => x && x.hp > 0 && x.side === t.side && x.nature === 1).length === 1)
        && (cfg.nature === 1 || cfg.nature === 2) && rel !== 2) {
      rel = 2;
    }

    // 凤凰（20620 圣炎的尊者）：在场时己方火系誓灵不会被克制；自身火系技能克制火系誓灵
    if (t.nature === 2 && (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 20620)) {
      if (rel === 1) rel = 0;
    }
    if (actor.talent === 20620 && cfg.nature === 2 && t.nature === 2) {
      rel = 1;
    }

    // 后土（22670 土正）：自身不会被克制
    if (t.talent === 22670 && rel === 1) {
      rel = 0;
    }

    // 倪克斯（22490 夜之本源）：夜间单体技能必定造成克制效果
    const isSingleFoe = EFF_FOE_ONE.has(Number(cfg.effType)) || Number(cfg.effType) === 1007 || targets.length === 1;
    if (actor.talent === 22490 && isSingleFoe && isNyxNightTime(curWeather)) {
      rel = 1;
    }

    // 拉结尔（22590 神赐之书）：同属性技能攻击被抵抗时消除抵抗
    if (actor.talent === 22590 && cfg.nature === actor.nature && rel === 2) {
      rel = 0;
    }

    // 爱丽丝（22750 红桃杀手）：目标带有红桃印记
    // 1层无法产生抵抗，2层会被任何属性克制
    if (t.hearts && t.hearts >= 2) {
      rel = 1; // 强制克制
    } else if (t.hearts && t.hearts >= 1 && rel === 2) {
      rel = 0; // 消除抵抗
    }

    // 奈亚拉托提普（21900 无貌之神）：伏行状态下自身不会被属性克制
    if (t.talent === 21900 && t.crawling && rel === 1) {
      rel = 0;
    }

    // P3-C 暗夜主宰（10336 专属改写·1446037）：4 回合内不会被克制
    if ((t.nightLordRounds || 0) > 0 && rel === 1) {
      rel = 0;
    }

    // 正体不明（21410 鵺）：不会被克制（weekPer/awk/extra 位/元素克制乘区全走 rel，改 rel 一处全生效）
    if (t.talent === 21410 && rel === 1) {
      rel = 0;
    }
    // 百搭料理（23130 白米饭）：抵抗所有属性的攻击（rel=1 克制 → 0；仍吃同属性抵抗）
    if (t.talent === 23130 && rel === 1) {
      rel = 0;
    }

    // P3-C 专属改写·克制改写（二百二十八）：唤醒中按表覆盖 rel（最后生效）
    const exclusiveRel = exclusiveRelOf(actor, cfg, t, allUnits);
    if (exclusiveRel != null) rel = exclusiveRel;

    // 沧海怒斩（10167）：攻击抵抗效果目标时不产生抵抗效果且必定暴击
    // 神明启示（10244）：下次攻击必定产生暴击（装填于 settleSkill 顶部，本次行动全程有效）
    let isForceCrit = !!(skillRule && skillRule.forceCrit) || nextAttackCritArmed;
    if (actor.talent === 21080 && ((actor.statLevels && actor.statLevels[105]) || 0) >= 2) {
      isForceCrit = true;
    }
    if (skillRule && skillRule.critOnResist && rel === 2) {
      rel = 0; // 消除抵抗效果
      isForceCrit = true;
    }
    // 炙炎加沸（10255）：对水属性誓灵造成伤害时必定暴击
    if (skillRule && skillRule.critOnNature != null && t.nature === skillRule.critOnNature) {
      isForceCrit = true;
    }
    // 连续飞踢（10313）浮空目标：处于浮空状态时，被攻击必定暴击
    if ((t.floatRounds || 0) > 0) {
      isForceCrit = true;
    }
    // 10186 飞升灵药：飞升中的誓灵被攻击必定被暴击
    if ((t.ascendRounds || 0) > 0) {
      isForceCrit = true;
    }
    // 戟（10316 字典飞击）：丢出的圣器是字典则必定暴击（圣器携带者命中该技能时）
    if (skillRule && skillRule.critIfRelicDict && actor.relicId && actor.relicMisc && actor.relicMisc.isDictionary) {
      isForceCrit = true;
    }
    // 攻击睡眠中的角色必定暴击（CfgBuff.lua:6024；爱丽丝 22750 睡眠时自如行动且减伤，不被强制暴击）
    if (t.buffs && t.buffs[BUFF_IDS.SLEEP] && t.talent !== 22750) {
      isForceCrit = true;
    }
    // P3-B 专属改写·暴击标记（二百二十七）
    if (t.critVulnOnce) { isForceCrit = true; t.critVulnOnce = false; }
    if ((t.critVulnMagicRounds || 0) > 0 && Number(cfg.type) === 2) isForceCrit = true;
    if ((actor.critVulnRound || 0) > 0) isForceCrit = true;
    if ((t.critVulnTargetRound || 0) > 0) isForceCrit = true;
    // P3-A/B 专属改写·必暴（行为表驱动）
    const elementExCrit = elementExclusiveBehavior(actor, cfg.id);
    if (elementExCrit && elementExCrit.critForce) isForceCrit = true;

    // 暴击判定：
    // 古河渚（22310 光坂连结）：己方有存活古河渚且防守方有盾时，防守方免疫暴击
    const nagisaCritImmune = (t.shield > 0 && (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 22310));
    // 1. 目标免疫暴击检测（如古河渚护盾免暴、初濑伊纲装备大蝴蝶结或免暴 Buff）
    // 提尔（22960 提尔之手）：自身免疫暴击
    const tyrCritImmune = (t.talent === 22960);
    const isImmune = !!((t.nightLordRounds || 0) > 0 || nagisaCritImmune || tyrCritImmune || t.immuneCrit || t.talent === 21410 || (t.buffs && (t.buffs[129] || t.buffs[3746] || t.buffs[4182] || t.buffs[5440] || t.buffs[5533])));
    // 2. 技能自带暴击阶段加成（如巨石坠落/风华破空枪/逆光贯雷：技能容易产生暴击）
    const skillCritStage = (skillRule && skillRule.skillCritStage) || 0;
    // 3. 施法者当前暴击等级（进场圣器加成 + 战斗内心神凝聚等 buff 升降）
    const focusCritBonus = (actor.buffs && (actor.buffs[10690] || (BUFF_IDS && actor.buffs[BUFF_IDS.FOCUS]))) ? 2 : 0;
    const critHitLv = ((actor.statLevels && actor.statLevels[111] != null)
      ? actor.statLevels[111]
      : ((actor.crit_hit_lv || 0) + (actor.critLv || 0))) + focusCritBonus + (Number(actor.nextCritBonus) || 0);
    // 坂上智代（22320 校园武帝）：场上每有 1 名 Clannad 誓灵，暴击等级 +1
    const clannadCritBonus = (actor.talent === 22320)
      ? (allUnits || []).filter(u => u && u.hp > 0 && isClannad(u.type)).length
      : 0;
    // 百鬼绫目（21970 久远之灵）：自身暴击等级 +1
    const ayameCritBonus = (actor.talent === 21970) ? 1 : 0;
    // 紫咲诗音（21980 福运之灵）：在场时使敌方所有誓灵暴击等级 -2
    const shionCritDebuff = (allUnits || []).some(u => u && u.hp > 0 && u.side !== actor.side && u.talent === 21980) ? -2 : 0;
    // 拉结尔（22590 神赐之书）：使用非自身属性技能时暴击等级+2
    const razielCritBonus = (actor.talent === 22590 && cfg.nature !== actor.nature) ? 2 : 0;
    // 常羲（23310 夜幕）：夜幕天气下暴击等级+2
    const changxiCritBonus = (actor.talent === 23310 && curWeather === WEATHER_IDS.NIGHT) ? 2 : 0;
    // 提尔（22960 提尔之手）：攻击提尔造成过伤害的目标暴击率+65%
    const tyrTargetCritBonus = (t.hitByTyr && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22960)) ? 0.65 : 0;
    // 应龙-乾元（22930 真龙）：2层真龙之力暴击率+30%
    const yinglongCritBonus = (actor.talent === 22930 && (actor.trueDragonLayers || 0) >= 2) ? 0.30 : 0;
    // 克图格亚（21930 行走的太阳）：攻击被暴击标记的目标暴击率+20%*层数
    const cthughaCritRateBonus = ((t.cfluguaCritVulnStacks || 0) * 0.20);

    // 111. 芬恩（22190 全知之鲑）：使用攻击技能时判定暴击等级+1
    const finnCritBonus = (actor.talent === 22190 && cfg.power > 0) ? 1 : 0;
    // 114. 增长天（22230 青云剑锋）：目标每受到增长天一次伤害，攻击者临时暴击等级+1
    const virudhakaCritBonus = (t.virudhakaHitStacks || 0);

    // 小熊外套（智代专属）：场上存在其他 CLANNAD 队友时，暴击等级额外 +2
    let tomoyoRelicCritExtra = 0;
    if (actor.relicMisc && actor.relicMisc.excl && actor.relicMisc.excl.tomoyoAllyExtraLv) {
      if ((allUnits || []).some(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id && CLANNAD_TYPES.has(Number(x.type)))) {
        tomoyoRelicCritExtra = actor.relicMisc.excl.tomoyoAllyExtraLv;
      }
    }
    const totalCritStage = critHitLv + skillCritStage + clannadCritBonus + ayameCritBonus + shionCritDebuff + razielCritBonus + changxiCritBonus + finnCritBonus + virudhakaCritBonus + tomoyoRelicCritExtra;
    const critRate = Math.min(1.0, Math.max(0, critRateOfStage(totalCritStage) + feelCritBonus(actor) + (actor.critRateBonus || 0) + sifCritRateBonus + tyrTargetCritBonus + yinglongCritBonus + cthughaCritRateBonus + (Number(actor.forgiveCritPct) || 0)));
    const crit = !isImmune && (isForceCrit || rnd() < critRate);
    actor.nextCritBonus = 0; // 10307 临时暴击等级一次性

    const roll = 0.85 + rnd() * 0.15; // 0.85~1.0 浮动（社区公式实测区间，2026-10-01 修正）
    const mit = Math.min(0.9, (t.selfMit || 0)
      + (allUnits || []).reduce((s, x) => s + (x.hp > 0 && x.side === t.side && x.id !== t.id ? (x.teamMit || 0) : 0), 0));
    // 圣器受击减伤：北京烤鸭「受到火属性技能伤害降低 N%」按技能属性；
    // 鹊儿圣器「受到的克制伤害降低 N%」按 rel===1。都作为独立乘区（不与天赋 mit 混算）。
    let relicTakenMul = 1.0;
    if (t.relicDmg) {
      const tnm = t.relicDmg.takenNatureMit;
      if (tnm && tnm[cfg.nature]) relicTakenMul *= (1 - tnm[cfg.nature]);
      if (rel === 1 && t.relicDmg.weekTakenMit) relicTakenMul *= (1 - t.relicDmg.weekTakenMit);
    }
    // 圣器固定受击减伤（冰结傀儡 / 千户的日记本：所受伤害 -10%）
    if (t.relicMisc && t.relicMisc.takenMit) relicTakenMul *= (1 - t.relicMisc.takenMit);
    // 冰糖燕窝：50% 概率把本次技能伤害降到 75%
    let relicHurtMitTriggered = false;
    if (t.relicMisc && t.relicMisc.hurtMitChance && rnd() < t.relicMisc.hurtMitChance.chance) {
      relicTakenMul *= t.relicMisc.hurtMitChance.mul;
      relicHurtMitTriggered = true;
    }
    // Mea羊：敌方全体受到伤害提高（持有者作为攻击方时对目标生效，在攻击方乘区处理更合适，
    // 这里按"目标受击"口径实现：只要**攻击方**带 foeTakenDmgUp 就放大本次伤害）
    if (actor.relicMisc && actor.relicMisc.foeTakenDmgUp) {
      relicTakenMul *= (1 + actor.relicMisc.foeTakenDmgUp);
    }
    // 纸巾盒（湊阿库娅专属）：每损失 1% 生命获得 0.5% 伤害减免，上限 50%
    const exclT0 = t.relicMisc && t.relicMisc.excl;
    if (exclT0 && exclT0.aquaLostHpMit && t.maxHp > 0) {
      relicTakenMul *= (1 - Math.min(0.5, (1 - t.hp / t.maxHp) * 100 * exclT0.aquaLostHpMit));
    }

    // 德梅特尔（20040 巨石守护神）：自身后方誓灵减免 30% 伤害
    let talentMit = 0;
    (allUnits || []).forEach(u => {
      if (u && u.hp > 0 && u.side === t.side && u.id !== t.id && u.talent === 20040) {
        if (Math.abs(u.pos[0]) === 2 && Math.abs(t.pos[0]) === 3 && u.pos[1] === t.pos[1]) {
          talentMit += 0.30;
        }
      }
    });

    // 专属 UR 伤害与减免乘区：
    // 1. 路西法（22540 傲慢之罪）：对生命大于等于50%的目标增伤 40%
    let luciferMul = 1.0;
    if (actor.talent === 22540 && ((t.hp / t.maxHp) >= 0.5 || actor.arroganceBoth)) {
      luciferMul = 1.40;
    }
    // 2. 阿瑞斯（20640 不屈的战魂）：每损失1%生命伤害提升1%
    let aresMul = 1.0;
    if (actor.talent === 20640) {
      aresMul = 1.0 + Math.max(0, 1.0 - (actor.hp / actor.maxHp));
    }
    // 3. 犹格索托斯（21910 虚空掌控）：每点虚空提供0.5%增伤
    //    10273 虚无爆发那一击按"倾泻前快照"计（void_energy 已在 settleSkill 顶部被消耗）
    let yogMul = 1.0;
    if (actor.talent === 21910) {
      const yogVoid = (voidBurst && actor.voidBurstSnapshot != null) ? actor.voidBurstSnapshot : (actor.void_energy || 0);
      yogMul = 1.0 + (yogVoid * 0.005);
    }
    // 4. 夏色祭（21950 友情的力量！）：攻击本回合被攻击过的目标伤害提升20%（若攻击者含hololive提升40%）
    let matsuriMul = 1.0;
    if (actor.talent === 21950 && t.hitThisRound) {
      const hasHolo = (t.hitByServants || []).some(s => s.isHolo);
      matsuriMul = hasHolo ? 1.40 : 1.20;
    }
    // 5. 鸢一折纸（21670 天使）：每层提升自身7%伤害，受到伤害降低3%
    let origamiAtkMul = 1.0;
    if (actor.talent === 21670) {
      origamiAtkMul = 1.0 + ((actor.angel_light_stacks || 0) * 0.07);
    }
    let origamiDefMit = 0;
    if (t.talent === 21670) {
      origamiDefMit = (t.angel_light_stacks || 0) * 0.03;
    }
    // 6. 爱丽丝（22750 红桃杀手）：睡眠时受到伤害降低30%
    let aliceSleepMit = 0;
    if (t.talent === 22750 && t.buffs && t.buffs[BUFF_IDS.SLEEP]) {
      aliceSleepMit = 0.30;
    }
    // 7. 朱雀（23280 泣朱）：自身下次行动增伤；受到技能伤害永久提高
    let zhuqueBoost = 1.0;
    if (actor.talent === 23280 && actor.zhuqueSelfBoost > 0) {
      zhuqueBoost = 1.0 + actor.zhuqueSelfBoost;
      actor.zhuqueSelfBoost = 0; // 消耗
    }
    let zhuqueVulnMul = 1.0;
    if (t.talent === 23280 && t.zhuqueVuln > 0) {
      zhuqueVulnMul = 1.0 + t.zhuqueVuln;
    }
    // 8. 鲲（21280 逍遥游）：下回合水伤额外提升50%
    let kunWaterMul = 1.0;
    if (actor.talent === 21280 && cfg.nature === 1 && actor.waterDmgBoostNextRound > 0) {
      kunWaterMul = 1.0 + actor.waterDmgBoostNextRound;
      actor.waterDmgBoostNextRound = 0; // 消耗
    }
    // 9. 言和（21330 言韵）：己方首名使用声音技能时，全队后续声音类技能伤害提升25%；若非首名使用声音技能，自身声音类技能伤害提升40%
    let yanheMul = 1.0;
    // 95/96. 22（21120 电气双子）与 33（21130 电气双子）：己方拥有同样天赋的其他誓灵在场时弹幕技能增伤40%
    let electricTwinsMul = 1.0;
    if ((actor.talent === 21120 || actor.talent === 21130) && isSoundSkill(cfg.id)) {
      const hasPartner = (allUnits || []).some(x => x && x.hp > 0 && x.side === actor.side && x.id !== actor.id &&
        (x.talent === 21120 || x.talent === 21130));
      if (hasPartner) electricTwinsMul = 1.40;
    }
    if (isSoundSkill(cfg.id)) {
      const yanheBuffActive = !!(battleState && battleState.yanheBuffActive && battleState.yanheBuffActive[actor.side]);
      const soundUsedBefore = !!(battleState && battleState.soundUsedSide && battleState.soundUsedSide[actor.side]);
      if (actor.talent === 21330) {
        if (!soundUsedBefore) {
          if (battleState) {
            battleState.yanheBuffActive = battleState.yanheBuffActive || {};
            battleState.yanheBuffActive[actor.side] = true;
          }
        } else {
          yanheMul = 1.40;
        }
      } else if (yanheBuffActive && soundUsedBefore) {
        yanheMul = 1.25;
      }
    }
    // 10. 阿尔忒弥斯（21540 辉光神狩）：目标生命大于等于60%时，增伤60%；低于60%时，增伤35%且物防下降1级
    let artemisMul = 1.0;
    let artemisDefDown = false;
    if (actor.talent === 21540) {
      if ((t.hp / t.maxHp) >= 0.60) {
        artemisMul = 1.60;
      } else {
        artemisMul = 1.35;
        artemisDefDown = true;
      }
    }

    // 尤莉与千户羁绊双子：千户受到的伤害降低30%（尤莉 22420）
    let chitoMit = 0;
    if (t.type === 3245001 && (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.type === 3242002)) {
      chitoMit = 0.30;
    }

    // 11. 洛天依-杏辞（21340 轻盈之杏）：受到的声音伤害提高
    let xingciMul = 1.0;
    if (isSoundSkill(cfg.id) && t.soundVulnRatio > 0) {
      xingciMul = 1.0 + t.soundVulnRatio;
    }

    // 战鼓之音（10195）标记消费：目标下回合声音技能伤害 +20%（一次性，用后即清）
    let soundBoostMul = 1.0;
    if (isSoundSkill(cfg.id) && actor.nextSoundBoost) {
      soundBoostMul = 1 + (Number(actor.nextSoundBoost.dmg) || 0);
      actor.nextSoundBoost = null;
    }

    // 12. 五河琴里（21660 炎魔）：火属性伤害攻击非火属性后下一次火伤提高25%
    let kotoriFireMul = 1.0;
    if (cfg.nature === 2 && t.kotoriFireVuln > 0) {
      kotoriFireMul = 1.0 + t.kotoriFireVuln;
      t.kotoriFireVuln = 0; // 消耗
    }

    // 13. 坂上智代（22320 校园武帝）：单体攻击连续攻击同一目标时伤害提高50%
    let tomoyoMul = 1.0;
    if (actor.talent === 22320 && isSingleFoe) {
      if (actor.lastTargetId === t.id) {
        tomoyoMul = 1.50;
      }
      actor.lastTargetId = t.id;
    }

    // 14. 白上吹雪（21940 小狐狸应援）：若本回合已行动过回复8%生命(Holo 16%)，未行动过技能伤害提升15%(Holo 30%)
    let fubukiMul = 1.0;
    if (actor.talent === 21940) {
      const isHoloUnit = isHolo(actor.type);
      if (actor.actedThisRound) {
        const healPct = isHoloUnit ? 0.16 : 0.08;
        const healAmt = Math.min(actor.maxHp - actor.hp, Math.round(actor.maxHp * healPct));
        if (healAmt > 0) {
          actor.hp += healAmt;
          wakeEffects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [actor.id],
            src_type: 1,
            src_id: 21940,
            id: 21940,
            effect_phase: phase,
            change_type: 200000,
            change_value: [healAmt],
            remove_round: 0,
          });
        }
      } else {
        fubukiMul = isHoloUnit ? 1.30 : 1.15;
      }
    }

    // 15. 湊阿库娅（21960 无敌的剑圣）：持有剑类圣器时伤害提升25%
    let aquaMul = (actor.talent === 21960 && isSwordRelic(actor.relicId)) ? 1.25 : 1.0;

    // 16. 星野梦美（21490 星之记忆）：连续释放上回合技能伤害提高100%，夜幕下连续释放技能造成的伤害提高150%
    let yumemiMul = 1.0;
    if (actor.talent === 21490) {
      if (actor.recordingSkillId === cfg.id) {
        yumemiMul = (curWeather === WEATHER_IDS.NIGHT) ? 2.50 : 2.00;
      }
      actor.recordingSkillId = cfg.id;
    }

    // 17. 吉普莉尔（21830 番外个体）：有队友时单体技能+30%，无队友时群体技能+30%
    let jibrilMul = 1.0;
    if (actor.talent === 21830) {
      const hasTeammates = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.id !== actor.id);
      if (hasTeammates && isSingleFoe) {
        jibrilMul = 1.30;
      } else if (!hasTeammates && !isSingleFoe) {
        jibrilMul = 1.30;
      }
    }

    // 18. 奈奥格索希普（22430 无名之雾）：使用技能时增伤 敌方存活数 * 20%
    let cxaoghaAtkMul = 1.0;
    if (actor.talent === 22430) {
      const foeCount = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side).length;
      cxaoghaAtkMul = 1.0 + (foeCount * 0.20);
    }

    // 奈奥格索希普（22430 无名之雾）：受单体技能时减伤 己方存活数 * 10%
    let cxaoghaDefMit = 0;
    if (t.talent === 22430 && isSingleFoe) {
      const allyCount = (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side).length;
      cxaoghaDefMit = allyCount * 0.10;
    }

    // 19. 玛查（21240 愤怒之魂）：对同一目标连续攻击伤害递增（每次+30%，最高至+120%）
    let machaMul = 1.0;
    if (actor.talent === 21240) {
      if (actor.machaTargetId === t.id) {
        machaMul = 1.0 + Math.min(1.20, (actor.machaCombo || 0) * 0.30);
      }
    }

    // 20. 羲和（20380 日御）：烈日天气下自身光属性技能造成的伤害提高50%
    let xiheMul = (actor.talent === 20380 && curWeather === WEATHER_IDS.SUN && cfg.nature === 5) ? 1.50 : 1.0;

    // 21. 赛特（21630 沙暴掌控）：己方使用风技能后，下一次土技能增伤50%
    let sethMul = 1.0;
    if (cfg.nature === 4 && battleState && battleState.sethWindUsedSide && battleState.sethWindUsedSide[actor.side]) {
      sethMul = 1.50;
      battleState.sethWindUsedSide[actor.side] = false;
    }

    // 22. 鲁格（22180 万艺全通）：目标属性与自身技能属性重合增伤50%；攻击方属性重合减伤30%
    let lughAtkMul = 1.0;
    if (actor.talent === 22180) {
      const myNatures = unitSkillNatures(actor);
      if (myNatures.has(t.nature)) lughAtkMul = 1.50;
    }
    let lughDefMit = 0;
    if (t.talent === 22180) {
      const defNatures = unitSkillNatures(t);
      if (defNatures.has(actor.nature)) lughDefMit = 0.30;
    }

    // 23. 雅典娜（21530 百战圣女）：当前累积增伤与圣盾减伤（每层15%）
    let athenaMul = (actor.talent === 21530 && actor.athenaDmgBoostCurr) ? (1.0 + actor.athenaDmgBoostCurr) : 1.0;
    let athenaMit = (t.talent === 21530 && t.athenaShields > 0) ? (t.athenaShields * 0.15) : 0;

    // 24. 德墨忒尔（21250 丰饶之祈）：土系技能累积增伤
    let demeterMul = (actor.talent === 21250 && actor.demeterCurrDmg) ? (1.0 + actor.demeterCurrDmg) : 1.0;

    // 25. 奥西里斯（20930 冥界归还）：队友上回合力尽后下回合增伤75%
    let osirisMul = (actor.talent === 20930 && actor.osirisCurrDmg) ? (1.0 + actor.osirisCurrDmg) : 1.0;

    // 26. 维德佛尔尼尔（20740 智慧的注视者）：己方风属性誓灵攻击时伤害提升己方能力总等级*10%（最高100%）
    let vedrfolnirMul = 1.0;
    if (cfg.nature === 3 || actor.nature === 3) {
      const hasVedr = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 20740);
      if (hasVedr) {
        let allyPosStages = 0;
        (allUnits || []).forEach(u => {
          if (u && u.hp > 0 && u.side === actor.side && u.statLevels) {
            [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
              if ((u.statLevels[p] || 0) > 0) allyPosStages += u.statLevels[p];
            });
          }
        });
        vedrfolnirMul = 1.0 + Math.min(1.0, Math.max(0, allyPosStages * 0.10));
      }
    }

    // 27. 海拉（21210 冥界侍从）：己方场地每存在一名暗属性誓灵，伤害提升20%
    let helDarkMul = 1.0;
    if (actor.talent === 21210) {
      const darkAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && natureOf(u.type) === 6).length;
      helDarkMul = 1.0 + (darkAllies * 0.20);
    }

    // 28. 须世理姬（22610 正室的妒火）：与大国主同场造成伤害+5%、减伤20%；不同场造成伤害+60%、受到伤害+50%
    let suserihimeMul = 1.0;
    if (actor.talent === 22610) {
      const hasOokuni = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && (u.talent === 22600 || u.type === 1344028));
      suserihimeMul = hasOokuni ? 1.05 : 1.60;
    }
    let suserihimeMit = 0;
    if (t.talent === 22610) {
      const hasOokuniT = (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && (u.talent === 22600 || u.type === 1344028));
      suserihimeMit = hasOokuniT ? 0.20 : -0.50;
    }

    // 29. 大国主（22600 出云之魂）：场上每存在一个高天原誓灵，己方高天原伤害提升12%
    let ookuniTakamaMul = 1.0;
    if (isTakamagahara(actor.type) && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22600)) {
      const takamaCount = (allUnits || []).filter(u => u && u.hp > 0 && isTakamagahara(u.type)).length;
      ookuniTakamaMul = 1.0 + (takamaCount * 0.12);
    }

    // 30. 米迦勒（21700 似神者）：对攻击过己方的敌方誓灵伤害提升30%
    let michaelMul = (actor.talent === 21700 && t.hasAttackedAllies) ? 1.30 : 1.0;

    // 31. 解慕漱（21860 天帝之子）：白天伤害提升50%，夜晚受伤害减少33%
    let haemosuMul = (actor.talent === 21860 && isDayTime(curWeather)) ? 1.50 : 1.0;
    let haemosuMit = (t.talent === 21860 && isNyxNightTime(curWeather)) ? 0.33 : 0;

    // 32. 卖火柴的少女（22400 幻梦成真）：队友每存在一种不同属性自身伤害+10%；回合内技能威力依次+10%
    let matchGirlMul = 1.0;
    if (actor.talent === 22400) {
      const distinctNatures = new Set((allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.id !== actor.id).map(u => natureOf(u.type)));
      const teamSkills = (battleState && ((battleState.teamSkillsThisRound && battleState.teamSkillsThisRound[actor.side]) || battleState.skillsUsedThisRound)) || 1;
      const stepBonus = Math.min(1.0, (teamSkills - 1) * 0.10);
      matchGirlMul = 1.0 + (distinctNatures.size * 0.10) + Math.max(0, stepBonus);
    }

    // 33. 伐楼那（22220 天海波流）：二回合内敌方每被水属性技能攻击过一次，再受到水属性技能伤害提升15%
    let varunaWaterMul = (cfg.nature === 1 && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22220))
      ? (1.0 + ((t.waterHitsReceived || 0) * 0.15))
      : 1.0;

    // 34. 荷鲁斯（20950 抗争之眼）：受到风属性伤害提升50%
    let horusWindMul = (cfg.nature === 3 && t.windVulnerableRounds > 0) ? 1.50 : 1.0;

    // 35. 年-新春异兽（21290 烈焰激怒）：己方风属性誓灵受到水、风系技能伤害减少25%
    let nianMit = (natureOf(t.type) === 3 && (cfg.nature === 1 || cfg.nature === 3) && (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 21290))
      ? 0.25
      : 0;

    // 36. 阿佛洛狄忒（22530 美神显现）：友方本回合本系技能伤害提升30%；成为敌方技能目标基础威力降低30%
    if (actor.talent === 22530 && cfg.nature !== natureOf(actor.type) && battleState) {
      battleState.aphroditeNonSameBoost = battleState.aphroditeNonSameBoost || {};
      battleState.aphroditeNonSameBoost[actor.side] = true;
    }
    let aphroditeSameMul = (battleState && battleState.aphroditeNonSameBoost && battleState.aphroditeNonSameBoost[actor.side] && cfg.nature === natureOf(actor.type)) ? 1.30 : 1.0;
    let aphroditePowerMul = (targets.some(tar => tar && tar.talent === 22530 && tar.side !== actor.side)) ? 0.70 : 1.0;

    // 37. 阎摩（22710 轮回判决）：暗系队友增伤20%，水系队友免伤15%
    let yamaMul = 1.0;
    let yamaMit = 0;
    if (actor.talent === 22710) {
      const darkAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && natureOf(u.type) === 6).length;
      yamaMul = 1.0 + (darkAllies * 0.20);
    }
    if (t.talent === 22710) {
      const waterAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side && natureOf(u.type) === 1).length;
      yamaMit = waterAllies > 0 ? 0.15 : 0;
    }

    // 38. 大吉祥天（22270 宝莲）：受到伤害降低30%
    let lotusMit = t.lotusBlessed ? 0.30 : 0;

    // 39. 通用当前增伤池（高朱蒙 21870、盖布 21170 等）
    let generalCurrDmgMul = 1.0 + (actor.currDmgBonus || 0);

    // 40. 拉（20920 光耀衍射）：群体攻击对随机1名目标造成150%伤害
    let raAoeBonusMul = 1.0;
    if (actor.talent === 20920 && targets.length > 1) {
      if (!actor.raAoeTargetId) {
        actor.raAoeTargetId = targets[Math.floor(rnd() * targets.length)].id;
      }
      if (t.id === actor.raAoeTargetId) {
        raAoeBonusMul = 1.50;
      }
    }

    // 41. 赫拉（22390 天后威严）：附加天赋持有者原始魔攻与敌方当前魔攻之差值的伤害
    let heraTrueDmg = 0;
    if (actor.talent === 22390) {
      const heraBaseMatk = actor.attrs ? actor.attrs.mag_atk : (actor.mag_atk || 0);
      const tMatk = (t.attrs ? t.attrs.mag_atk : (t.mag_atk || 0)) * attrLvMul((t.statLevels && t.statLevels[102]) || 0);
      if (heraBaseMatk > tMatk) {
        heraTrueDmg = Math.floor(heraBaseMatk - tMatk);
      }
    }

    // Phase 6 UR 专属增伤与减免乘区：
    // 42. 冰雪女皇（23260 镜中迷局）：目标速度低于自身时提升速度差比例伤害（上限60%）
    let iceQueenMul = 1.0;
    if (actor.talent === 23260) {
      const actSpd = effectiveSpeed(actor, allUnits, battleState);
      const tarSpd = effectiveSpeed(t, allUnits, battleState);
      if (actSpd > tarSpd && actSpd > 0) {
        iceQueenMul = 1.0 + Math.min(0.60, (actSpd - tarSpd) / actSpd);
      }
    }

    // 43. 睡美人（23220 沉睡魔咒）：沉睡状态下技能伤害提升50%
    let sleepBeautyMul = (actor.talent === 23220 && (actor.sleepCurseRounds > 0 || (actor.buffs && actor.buffs[BUFF_IDS.SLEEP]))) ? 1.50 : 1.0;

    // 44. 尼曼（23170 身沐血衣）：每层血污提升7%伤害
    let nemainMul = 1.0 + ((actor.nemainBlood || 0) * 0.07);

    // 45. 弗丽嘉（22970 守秘者）：受克制/抵抗后下次伤害+60%；己方受克制减免40%
    let friggaMul = (actor.talent === 22970 && actor.friggaNextBonus > 0) ? (1.0 + actor.friggaNextBonus) : 1.0;
    let friggaMit = (rel === 1 && (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 22970)) ? 0.40 : 0;

    // 46. 玄武（23290 隐忍的回击）：受创后己方下次行动伤害提升
    let xuanwuMul = 1.0 + (actor.xuanwuNextBonus || 0);

    // 47. 桓雄（22920 创生）：回复生命后下次伤害+50%、受伤害-25%
    let hwanungMul = (actor.hwanungBuffDmg > 0) ? (1.0 + actor.hwanungBuffDmg) : 1.0;
    let hwanungMit = (t.hwanungBuffMit > 0) ? t.hwanungBuffMit : 0;

    // 48. 苏摩（23140 永生血酒）：每层血铠提升20%伤害
    let somaMul = 1.0 + ((actor.bloodArmorLayers || 0) * 0.20);

    // 49. 神楽Mea（22810 大家的财布）：攻击消耗全部财布，每层增伤20%并随机升1级能力
    let meaMul = 1.0;
    if (actor.talent === 22810 && (actor.walletLayers || 0) > 0) {
      const wLayers = actor.walletLayers;
      actor.walletLayers = 0;
      meaMul = 1.0 + (wLayers * 0.20);
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      for (let i = 0; i < wLayers; i++) {
        const p = props[Math.floor(rnd() * props.length)];
        gainStat(actor, p, 1, { effects: wakeEffects, srcId: 22810, phase });
      }
    }

    // 50. 冰糖燕窝（23100 正气强身）：队友无盾时伤害提升30%
    let yanwoMul = 1.0;
    if (actor.talent === 23100) {
      const hasUnshieldedTeammate = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.id !== actor.id && (!u.shield || u.shield <= 0));
      if (hasUnshieldedTeammate) yanwoMul = 1.30;
    }

    // 51. 鲷鱼烧（23110 黄色班佳吉）：血线增伤80%
    let taiyakiMul = 1.0;
    if (actor.talent === 23110) {
      let posSum = 0;
      if (actor.statLevels) {
        Object.values(actor.statLevels).forEach(v => { if (v > 0) posSum += v; });
      }
      const threshold = 0.50 - Math.floor(posSum / 3) * 0.10;
      const tMaxHp = t.maxHp || (t.attrs && t.attrs.hp) || t.hp;
      if ((t.hp / tMaxHp) <= threshold) {
        taiyakiMul = 1.80;
      }
    }

    // 52. 香风智乃（22860 小小看板娘）：增伤20%、减伤10%，受创叠加
    const hasChinoAlly = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22860);
    const chinoAllyDmgMul = hasChinoAlly ? 1.20 : 1.0;
    const hasChinoDef = (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 22860);
    const chinoAllyMit = hasChinoDef ? 0.10 : 0.0;
    const actorChinoStacks = isGochuumon(actor.type)
      ? Math.max(actor.chinoPhyStacks || 0, actor.chinoMagStacks || 0)
      : (cfg.type === 1 ? (actor.chinoPhyStacks || 0) : (actor.chinoMagStacks || 0));
    const chinoSelfDmgMul = 1.0 + (actorChinoStacks * 0.05);
    const defChinoStacks = isGochuumon(t.type)
      ? Math.max(t.chinoPhyStacks || 0, t.chinoMagStacks || 0)
      : (cfg.type === 1 ? (t.chinoPhyStacks || 0) : (t.chinoMagStacks || 0));
    const chinoSelfMit = defChinoStacks * 0.05;

    // 53. 桐间纱路（22900 打工的贵族）：增伤赋能
    let syaroMul = 1.0 + (actor.syaroDmgBonus || 0);

    // 54. 努特（22830 死亡之风）：诅咒受伤害+20%
    let nutCurseVuln = (t.curseOfDead > 0) ? 1.20 : 1.0;

    // 55. 豌豆公主（23250 散华）：受群攻伤害+20%
    let peaVulnMul = (t.talent === 23250 && (!isSingleFoe || targets.length > 1)) ? 1.20 : 1.0;

    // =========================================================================
    // SR 阶段二（Phase 2）独立数值乘区
    // =========================================================================
    // 21. 荒吐（20120 异能信仰）：攻击本回合已行动对象时，技能威力提升30%
    let arahabakiPowerMul = 1.0;
    if (actor.talent === 20120 && t.actedThisRound) {
      arahabakiPowerMul = 1.30;
    }
    // 22. 哈迪斯（20240 冥渊的裁定者）：目标生命低于50%时伤害提升50%
    let hadesMul = (actor.talent === 20240 && (t.hp / t.maxHp) < 0.50) ? 1.50 : 1.0;
    // 26. 霍德尔（20760 混乱的黑暗）：单体技能随机目标且威力提升50%
    let hodurMul = (actor.talent === 20760 && isSingleFoe) ? 1.50 : 1.0;
    // 28. 史尔特尔（21220 灭世之炎）：同回合己方每使用一次火攻，下次火攻伤害提升25%（可叠加）
    let surtrMul = 1.0;
    if (actor.talent === 21220) {
      const sideKey = 'surtrFireStacks_' + actor.side;
      battleState[sideKey] = (battleState[sideKey] || 0);
      surtrMul = 1.0 + (battleState[sideKey] * 0.25);
    }
    // 29. 阿斯特赖亚（21560 正义星辰）：目标能力等级总和为正时增伤 总和*15%
    let astraeaMul = 1.0;
    if (actor.talent === 21560) {
      let posSum = 0;
      if (t.statLevels) {
        Object.values(t.statLevels).forEach(lv => { if (lv > 0) posSum += lv; });
      }
      if (posSum > 0) astraeaMul = 1.0 + (posSum * 0.15);
    }
    // 30. 萨麦尔（21750 怒之毁灭者）：攻击曾对自己造成过伤害的目标锁定不变且伤害提升30%
    let samaelMul = (actor.talent === 21750 && (actor.hitByServants || []).some(s => s.id === t.id)) ? 1.30 : 1.0;
    // 31. 贝尔芬格（21760 怠之长眠者）：上回合未造成伤害则本回合减伤50%
    let belphegorMit = ((t.talent === 21760) && (t.belphegorNoDmgLastRound === true)) ? 0.50 : 0;
    // 32. 阿斯莫德（21780 爱之恶堕者）：单体技能命中使目标下回合伤害降低20%
    let asmodeusMul = (actor.asmodeusDmgDownNextRound === true) ? 0.80 : 1.0;
    // 57. 珀耳塞福涅（21510 双面冥后）：辅助后己方下次伤害提升（通常25%，夜幕50%）
    // =========================================================================
    // SR 阶段四（Phase 4）暴击、护盾与防守乘区
    // =========================================================================
    // 79. 祝融（21790 火正）：场上每名火系誓灵增伤10%，共工在场时双向+50%
    let zhurongMul = 1.0;
    if (actor.talent === 21790) {
      const fireCount = (allUnits || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.nature === 2).length;
      zhurongMul = 1.0 + (fireCount * 0.10);
      if ((allUnits || []).some(x => x && x.hp > 0 && x.side === actor.side && x.talent === 21800)) zhurongMul *= 1.50;
    }
    // 80. 共工（21800 水师）：场上每名水系誓灵增伤10%，祝融在场时双向+50%
    let gonggongMul = 1.0;
    if (actor.talent === 21800) {
      const waterCount = (allUnits || []).filter(x => x && x.hp > 0 && x.side === actor.side && x.nature === 1).length;
      gonggongMul = 1.0 + (waterCount * 0.10);
      if ((allUnits || []).some(x => x && x.hp > 0 && x.side === actor.side && x.talent === 21790)) gonggongMul *= 1.50;
    }
    // 75. 嫦娥（21300 长生之愿）：同回合内受到多次伤害时，每次递减25%
    let changeMul = 1.0;
    if (t.talent === 21300) {
      const hits = (t.hitsThisRound || 0);
      changeMul = Math.max(0, 1.0 - (hits * 0.25));
    }
    // 76. 赫拉克勒斯（21550 十二功绩）：每层功绩增伤12%
    let heraclesMul = 1.0 + ((actor.heraclesFeats || 0) * 0.12);
    // 78. 普塔（21640 万物熔铸）：清空己方护盾数 x 35% 增伤
    let ptahMul = 1.0 + (actor.ptahClearedCount || 0) * 0.35;
    // 65. 嫘祖（20410 轻丝之衣）：自身受克制伤害减少50%，队友减少25%
    let leizuMit = 0;
    if (rel === 1) {
      if (t.talent === 20410) leizuMit = 0.50;
      else if ((allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.talent === 20410)) leizuMit = 0.25;
    }
    // 66. 巴德尔（20750 庇护的光芒）：非暗属性伤害减少30%，暗属性伤害翻倍
    let baldrMit = 0;
    if (t.talent === 20750 && cfg.nature !== 6) baldrMit = 0.30;
    let baldrDarkMul = ((t.talent === 20750 && cfg.nature === 6) ? 2.0 : 1.0);
    // 73. 泣泽女神（22480 长寿之神女）：自身减伤20%，在场每回合己方额外减伤5%（上限30%）
    let nakizawaSelfMit = (t.talent === 22480) ? 0.20 : 0;
    let nakizawaTeamMit = 0;
    (allUnits || []).forEach(x => {
      if (x && x.hp > 0 && x.side === t.side && x.talent === 22480) {
        nakizawaTeamMit = Math.min(0.30, (x.nakizawaRounds || 0) * 0.05);
      }
    });
    // 74. 塞勒涅（21230 不寐之月）：己方处于异常状态的誓灵受到伤害减少35%
    let seleneMit = 0;
    if ((allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.talent === 21230) &&
        t.buffs && Object.keys(t.buffs).length > 0) {
      seleneMit = 0.35;
    }
    // 69. 兀尔德（20840 命运·过去）：上回合每受击1次，本回合增伤17%
    let urdMul = 1.0 + ((actor.verdandiPrevHits || 0) * 0.17);
    // 70. 薇儿丹蒂（20850 命运·现在）：存在护盾时伤害提升20%
    let verdandiMul = ((actor.talent === 20850 && (actor.shield || 0) > 0) ? 1.20 : 1.0);

    // =========================================================================
    // SR 阶段五（Phase 5）阵营生态乘区
    // =========================================================================
    // 97. 小舟酱（21420 前线情报）：回合初随机增伤
    // 88. 水瓶座（21050 神侍）：受其水系辅助者增伤15%持续2回合
    let aquariusMul = 1.0 + (actor.aquariusDmgBonus || 0);
    // =========================================================================
    // SR 阶段六（Phase 6）终局伤害乘区
    // =========================================================================
    // 110. 伊塔库亚（21920 风行者之路）：每个风行者印记增伤10%
    let itaquaMul = 1.0 + ((actor.windWalkerMarks || 0) * 0.10);
    // 118. 摩伽罗（22520 圆融境界）：本回合攻击每下降1级，下回合增伤20%
    let makaraMul = 1.0 + ((actor.makaraAtkDownLast || 0) * 0.20);
    // 122. 阿修罗（22720 阿修罗道）：消耗50战意使用攻击技能增伤45%
    let asuraMul = 1.0 + ((actor.asuraWillActive && actor.asuraWill >= 50) ? 0.45 : 0);
    // 128. 凡赛堤（22990 审判）：敌方携带法典时受到伤害提升20%
    let forsetiVulnMul = (t.forsetiCodexActive ? 1.20 : 1.0);
    // 116. 持国天（22280 中道之琴）：声音类技能己方2回合内受到伤害降低15%
    let dhrtarastraMit = 0;
    if ((allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.dhrtarastraMitRounds > 0)) {
      dhrtarastraMit = 0.15;
    }
    // 110. 伊塔库亚（21920 风行者之路）：风系技能后本回合己方受群体伤害减少30%
    let itaquaAoeMit = 0;
    if (!isSingleFoe && (allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.itaquaWindUsed)) {
      itaquaAoeMit = 0.30;
    }
    // 118. 摩伽罗（22520 圆融境界）：防御每下降1级，下回合受到伤害降低20%
    let makaraMit = Math.min(0.9, ((t.makaraDefDownLast || 0) * 0.20));


    let xiaozhouMul = 1.0 + (actor.xiaozhouDmgBonus || 0);
    // 99. 子（21990 通灵）：每名被击败誓灵增伤20%（上限5名=100%）
    let ziMul = 1.0 + ((actor.ziDefeatedCount || 0) * 0.20);
    // 100. 丑（22000 画地为牢）：己方其他誓灵每拥有1级正向防御等级增伤25%
    let chouMul = 1.0;
    if (actor.talent === 22000) {
      let allyDefLv = 0;
      (allUnits || []).forEach(x => {
        if (x && x.hp > 0 && x.side === actor.side && x.id !== actor.id && x.statLevels) {
          allyDefLv += Math.max(0, x.statLevels[103] || 0);
          allyDefLv += Math.max(0, x.statLevels[104] || 0);
        }
      });
      chouMul = 1.0 + (allyDefLv * 0.25);
    }
    // 106. 申（22070 遇强则强）：敌方数量>=己方时增伤30%
    let shenMul = 1.0;
    if (actor.talent === 22070) {
      const foeCount = (allUnits || []).filter(x => x && x.hp > 0 && x.side !== actor.side).length;
      const allyCount = (allUnits || []).filter(x => x && x.hp > 0 && x.side === actor.side).length;
      if (foeCount >= allyCount) shenMul = 1.30;
    }
    // 107. 酉（22080 阴阳乾坤）：光属性誓灵最多时获得光系修正且增伤80%
    let youMul = 1.0;
    if (actor.talent === 22080) {
      const allies = (allUnits || []).filter(x => x && x.hp > 0 && x.side === actor.side);
      const natureCount = { 5: 0, 6: 0 };
      allies.forEach(a => { if (natureCount[a.nature] != null) natureCount[a.nature]++; });
      if (natureCount[5] > 0 && natureCount[5] >= natureCount[6]) youMul = 1.80;
    }
    // 108. 戌（22090 协同）：布阵周围每存在1名火系誓灵增伤40%
    let xuMul = 1.0;
    if (actor.talent === 22090) {
      const adjacentFire = (allUnits || []).filter(x => x && x.hp > 0 && x.side === actor.side &&
        x.nature === 2 && Math.abs((x.pos && x.pos[0] || 0) - (actor.pos && actor.pos[0] || 0)) <= 1).length;
      xuMul = 1.0 + (adjacentFire * 0.40);
    }
    // 102. 辰（22030 真炎庇佑）：己方受火系技能伤害减半
    let chenFireMit = ((allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.talent === 22030) && cfg.nature === 2) ? 0.50 : 0;
    // 彩虹之神使（21590）：使用辅助技能当回合所受伤害减少30%
    let irisMit = (t.irisMitActive && t.talent === 21590) ? 0.30 : 0;
    // 87. 摩羯座（21040 卑微的献身）：场上其余友方受单体技能伤害降低20%
    let capricornMit = 0;
    if (isSingleFoe && t.id !== actor.id) {
      if ((allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.id !== t.id && x.talent === 21040)) {
        capricornMit = 0.20;
      }
    }
    // 89. 双鱼座（21060 隐蔽双子）：被自身来源效果治疗后下次受技能伤害减伤30%
    let piscesMit = (t.piscesNextMit ? 0.30 : 0);
    // 92. 双子座（21090 光影双生）：每命中一名敌人减伤10%（可叠加，受击清零）
    let geminiMit = Math.min(0.9, (t.geminiMitStacks || 0) * 0.10);
    // 94. 狮子座（21110 狮王之裘）：被技能攻击消耗1层减伤20%
    let leoMit = 0;
      if (t.talent === 21110 && (t.leoFurStacks || 0) > 0 && cfg.power > 0) {
        t.leoFurStacks--;
        leoMit = 0.20;
        gainStat(t, 102, 1, { effects: wakeEffects, srcId: 21110, atkId: actor.id, srcServantId: t.id, phase });
      }
    // 105. 未（22060 日斜）：在场时己方誓灵生命回复量提升50%
    let weiHealBonus = ((allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.talent === 22060)) ? 0.50 : 0;


    let persephoneSupportMul = 1.0 + (actor.persephoneNextDmgBonus || 0);

    // 27. 塞赫美特（21190 嗜血医者）：被治疗者下次攻击伤害提升30%
    let sekhmetMul = 1.0 + (actor.sekhmetNextAtkBonus || 0);

    // =========================================================================
    // SR 阶段三（Phase 3）天气与周期伤害乘区
    // =========================================================================
    // 57. 珀耳塞福涅（21510 双面冥后）：对暗系誓灵伤害提升150%，夜幕下为200%
    let persephoneDarkMul = 1.0;
    if (actor.talent === 21510 && t.nature === 6) {
      persephoneDarkMul = (curWeather === WEATHER_IDS.NIGHT) ? 2.00 : 1.50;
    }
    // 55. 巴吉里斯克（21460 剧毒暴君）：场上每存在一名中毒誓灵增伤50%
    let basiliskMul = 1.0;
    if (actor.talent === 21460) {
      const poisonedCount = (allUnits || []).filter(x => x && x.hp > 0 && x.buffs && x.buffs[BUFF_IDS.POISON]).length;
      basiliskMul = 1.0 + (poisonedCount * 0.50);
    }
    // 59. 厄庇墨透斯（22360 后见后知者）：每回合递增40%伤害（上限200%）
    let epimetheusMul = 1.0 + (actor.epimetheusDmgBonus || 0);
    // 46. 厄洛斯（20660 姻缘的箭矢）：敌方契约者对我方契约者造成伤害减半
    let erosMul = 1.0;
    if (actor.erosContractWith === t.id && actor.erosContractRounds > 0) {
      erosMul = 0.50;
    }
    // 63. 小红帽（22760 童话之心）：自身物防等级每高于目标1级增伤15%
    let redHoodMul = 1.0;
    if (actor.talent === 22760) {
      const myDefLv = (actor.statLevels && actor.statLevels[103]) || 0;
      const foeDefLv = (t.statLevels && t.statLevels[103]) || 0;
      const diff = myDefLv - foeDefLv;
      if (diff > 0) redHoodMul = 1.0 + (diff * 0.15);
    }

    // 37. 莎莉叶（22550 光暗交织）：与光暗属性交互每次增伤10%（最高50%）
    let sharayahMul = 1.0;
    if (actor.talent === 22550) {
      sharayahMul = 1.0 + Math.min(0.50, (actor.sharayahStacks || 0) * 0.10);
    }

    // 56. 亚瑟王（23000 雾夜启明）：受伤降低20%
    let arthurMit = (t.talent === 23000) ? 0.20 : 0;

    // 57. 应龙-乾元（22930 真龙）：每层真龙之力增伤4%
    let yinglongMul = 1.0 + ((actor.trueDragonLayers || 0) * 0.04);

    // =========================================================================
    // SR 阶段一（Phase 1）伤害乘区
    // =========================================================================
    // 索贝克（20960 元素连击）：使用与上回合不同属性的攻击技能伤害提升85%
    let sobekMul = 1.0;
    if (actor.talent === 20960 && actor.lastUsedSkillNature != null && actor.lastUsedSkillNature !== cfg.nature) {
      sobekMul = 1.85;
    }
    // 射手座（21030 永生之重）：血量高于50%造成伤害提高30%
    let sagittariusAtkMul = (actor.talent === 21030 && (actor.hp / actor.maxHp) > 0.5) ? 1.30 : 1.0;
    // 席兹（21380 天翔之心）：下回合获得加成
    let xiziMul = (actor.talent === 21380 && (actor.xiziNextDmgBoost || 0) > 0) ? (1.0 + actor.xiziNextDmgBoost) : 1.0;
    // 寅（22010 如虎添翼）：己方每有1级正向速度等级提升15%伤害
    let yinMul = 1.0;
    if (actor.talent === 22010) {
      let posSpdSum = 0;
      (allUnits || []).forEach(u => {
        if (u && u.hp > 0 && u.side === actor.side) {
          const spd = (u.statLevels && u.statLevels[105]) != null ? u.statLevels[105] : (u.speed_lv || 0);
          if (spd > 0) posSpdSum += spd;
        }
      });
      yinMul = 1.0 + (posSpdSum * 0.15);
    }
    // 克希拉（22800 附肢触须）：每根触须造成伤害提升7%
    let cthyllaAtkMul = 1.0 + ((actor.tentacleStacks || 0) * 0.07);
    // 瑶姬（23040 镇水）：受水属性攻击技能伤害降低50%
    let yaojiMitMul = ((allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 23040) && cfg.nature === 1) ? 0.50 : 1.0;
    // 射手座（21030 永生之重）：血量低于等于50%受到伤害减少30%
    let sagittariusDefMit = (t.talent === 21030 && (t.hp / t.maxHp) <= 0.5) ? 0.30 : 0;


        // 可选乘区（无尽冒险塔 buff / 装备词条 / 技能爆伤加成）：
    const natM = (actor.natMul && actor.natMul[cfg.nature]) || 0;
    const wkM = rel === 1 ? ((actor.weekMul || 0) + ((actor.natWeekMul && actor.natWeekMul[cfg.nature]) || 0)) : 0;
    const critMulBonus = ((skillRule && skillRule.critMulBonus) || 0)
      + (nextAttackCritArmed ? nextAttackCritDmgArmed : 0); // 神明启示（10244）：暴击伤害提升35%
    // 克图格亚（21930 行走的太阳）：己方暴击伤害提升10%
    const cthughaTeamCritDmg = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21930) ? 0.10 : 0;
    // 克希拉（22800 附肢触须）：每根触须提升7%暴击伤害
    const cthyllaCritDmg = ((actor.tentacleStacks || 0) * 0.07);
    // 64. 麒麟（20400 祥瑞赐福）：自身暴击修正变为2倍
    const qilinCritOverride = (actor.talent === 20400) ? 2.0 : 0;
    const rawCritMul = qilinCritOverride || (1.5 + (actor.critMul || 0) + critMulBonus + sifCritMulBonus + cthughaTeamCritDmg + cthyllaCritDmg
      // 狂野小子（理世专属）：己方暴击伤害提升 3%（携带者在场的全队光环）
      + (allUnits || []).reduce((s, x) => s + ((x && x.hp > 0 && x.side === actor.side && x.relicMisc && x.relicMisc.excl && x.relicMisc.excl.rizeTeamCritMul) ? x.relicMisc.excl.rizeTeamCritMul : 0), 0));
    // 受击方暴击减免（维摩那/虎儿圣器/小熊外套等提供的 critMit，降低受到的暴击超额伤害）
    const effectiveCritMul = 1.0 + Math.max(0, (rawCritMul - 1.0) * (1 - Math.min(1.0, t.critMit || 0)));
    const awk = rel === 1 ? Math.min(0.9, t.antiWeek || 0) : 0;
    // 伤害骨架（2026-10-01 换官方社区反推口径）：(攻击方等级+5)/50 × (攻方攻/守方防) × 威力 × 乘区。
    // 原饱和式 power×atk/(atk+def) 把等级差压平（1 级/75 级麒麟打同敌仅 2~5 倍差），与官方手感
    // 不符；官方关卡血量（wiki 380/380 命中本服务端地图数据）按此骨架设计，等级压制应显著。
    // 注意 def 为 0/极小值时钳制到 1 防除零。
    const safeDef = Math.max(1, def);
    const lvTerm = ((Number(actor.level) || 1) + (Number(actor.levelOverrideBonus) || 0) + 5) / 50;
    // 动态威力（CfgSkillDetail fightDesc 实证，规则见 skill_effect_data.js）：
    // 惩戒（10082）：对手能力等级越高威力越高；终结之刃（10077）：次数越少威力越高
    let effPower = Number(cfg.power) || 0;
    // 聚力击（10117，批次H3）：连续使用每回合威力翻倍（×2^streak，上限防失控）；
    // 本次使用先按既有 streak 计倍率，再把 streak+1（miss 分支重置）
    if (skillRule && skillRule.powerDoublePerUse) {
      const streak = Math.min(Number(skillRule.powerDoublePerUse.max) || 3, Number(actor.focusStrikeStreak) || 0);
      if (streak > 0) effPower = Math.round(effPower * Math.pow(2, streak));
      actor.focusStrikeStreak = streak + 1;
      actor.focusStreakSkillId = cfg.id;
    }
    if (skillRule && skillRule.powerByTargetStatLv) {
      const r = skillRule.powerByTargetStatLv;
      const posSum = Object.values(t.statLevels || {}).reduce((s, v) => s + (v > 0 ? v : 0), 0);
      effPower = Math.min(r.cap, r.base + posSum * r.perLv);
    }
    // 犹格索托斯 10273「虚无爆发」：每 1 点虚空 +1.5% 伤害（100 点 = ×2.5），按施放前快照计
    if (voidBurst && actor.voidBurstSnapshot > 0) {
      effPower = Math.round(effPower * (1 + actor.voidBurstSnapshot * Number(vbRule.voidBurst.dmgPerPoint)));
    }
    // 天使之光族（批次F：10240 日轮 / 10239 天翼）——攻击前消耗层数
    if (cfg.id === 10240 && (actor.angel_light_stacks || 0) > 0) {
      const consumed = Math.min(6, actor.angel_light_stacks);
      actor.angel_light_stacks -= consumed;
      effPower = Math.round(effPower * (1 + 0.12 * consumed));
    }
    // 天翼（10239）：每消耗1层额外攻击1次，每次伤害为上一次的80%（写成 extraHits 递减链）
    let angelExtraHits = null;
    if (cfg.id === 10239 && (actor.angel_light_stacks || 0) > 0) {
      const consumed = Math.min(3, actor.angel_light_stacks);
      actor.angel_light_stacks -= consumed;
      angelExtraHits = { count: consumed, pct: 0.80, decay: true };
    }
    if (skillRule && skillRule.powerByPpUsed) {
      const r = skillRule.powerByPpUsed;
      const skEntry = (actor.skills || []).find(s => s.id === cfg.id);
      const used = Math.max(0, (Number(cfg.pp) || 0) - (skEntry ? skEntry.pp : cfg.pp));
      effPower = Math.min(r.cap, r.base + used * r.perUse);
    }
    // 圣器伤害乘区（批次 3）：声音类 / 群体 / 物理单体 / 属性增伤 / 对正向能力目标增伤。
    // 全部是乘区（与天赋同层），加在 relicDmgMul 里一次乘进去。
    const rdm = actor.relicDmg || null;
    const miscW = actor.relicMisc || null; // 批次 4 词条（天气石增伤等）在乘区里也要用
    let relicDmgMul = 1.0;
    if (rdm) {
      // 通用增伤：十拳剑（vsPositiveStats）的 15% 是**有条件**的，不能无条件并入 general，
      // 否则会对所有目标都增伤。条件是「目标物攻+魔攻等级之和 > 0」。
      if (rdm.general) {
        if (!rdm.vsPositiveStats) {
          relicDmgMul *= (1 + rdm.general);
        } else {
          const foeAtkSum = ((t.statLevels && t.statLevels[101]) || 0) + ((t.statLevels && t.statLevels[102]) || 0);
          if (foeAtkSum > 0) relicDmgMul *= (1 + rdm.general);
        }
      }
      if (rdm.sound && isSoundSkill(cfg.id)) relicDmgMul *= (1 + rdm.sound);
      if (rdm.aoe) {
        const isAoeSkill = EFF_FOE_ALL.has(Number(cfg.effType)) || EFF_ANY_COL.has(Number(cfg.effType)) ||
          EFF_ANY_ROW.has(Number(cfg.effType)) || Number(cfg.effType) === 3007 ||
          EFF_FRIEND_ALL.has(Number(cfg.effType));
        if (isAoeSkill) relicDmgMul *= (1 + rdm.aoe);
      }
      if (rdm.singlePhy) {
        const isSinglePhy = Number(cfg.type) === 1 && (EFF_FOE_ONE.has(Number(cfg.effType)) || Number(cfg.effType) === 1007);
        if (isSinglePhy) relicDmgMul *= (1 + rdm.singlePhy);
      }
      if (rdm.natureDmgMul && rdm.natureDmgMul[cfg.nature]) relicDmgMul *= (1 + rdm.natureDmgMul[cfg.nature]);
      // 气象石：召唤出的对应天气下，所有技能伤害 +20%
      if (miscW && miscW.weatherSummon && curWeather === Number(miscW.weatherSummon.nature)) {
        relicDmgMul *= (1 + (miscW.weatherSummon.dmg || 0.20));
      }
      // 鲷鱼烧：本场每受 1 次技能伤害 +3.5%，最多 4 层
      const miscA = actor.relicMisc;
      if (miscA && miscA.stackDmgPerHurt && actor.relicHurtStacks > 0) {
        const st = Math.min(miscA.stackDmgPerHurt.max, actor.relicHurtStacks);
        relicDmgMul *= (1 + miscA.stackDmgPerHurt.per * st);
      }
      // 法国军帽：伤害随机提高 1~15%（每次命中摇一次）
      if (miscA && miscA.randomDmgRange) {
        const [lo, hi] = miscA.randomDmgRange;
        relicDmgMul *= (1 + lo + rnd() * (hi - lo));
      }
      // —— 联动圣器专属段乘区（2026-10-25 家族落地，relicMisc.excl）——
      // 破裂剑族：连续使用相同技能时每回合 +N%，上限 M
      if (miscA && miscA.repeatSkillDmg) {
        if (actor.relicLastSkillId === cfg.id) {
          actor.relicRepeatCount = (actor.relicRepeatCount || 0) + 1;
        } else {
          actor.relicLastSkillId = cfg.id;
          actor.relicRepeatCount = 0;
        }
        const cap = Math.round(miscA.repeatSkillDmg.max / miscA.repeatSkillDmg.per);
        const n = Math.min(cap, actor.relicRepeatCount);
        if (n > 0) relicDmgMul *= (1 + miscA.repeatSkillDmg.per * n);
      }
    }
    // —— 联动圣器专属段乘区（续）：不依赖 relicDmg 词条对象，relicMisc.excl 即生效 ——
    const miscEx = actor.relicMisc || null;
    if (miscEx && miscEx.excl) {
      const exc = miscEx.excl;
      // 提比（智乃专属）：自身伤害 +3%（通用段「其余己方 +5%」在下方 allyRelicUp）
      if (exc.chinoSelfDmgUp) relicDmgMul *= (1 + exc.chinoSelfDmgUp);
      // 鏖杀公（十香专属）：连续攻击同一个单位伤害 +10%（跨回合追踪主目标集合）
      if (exc.tookaRepeatMul) {
        const curIds = targets.map(x => x && x.id).join(',');
        if (curIds && curIds === actor.relicLastTargetIds) relicDmgMul *= (1 + exc.tookaRepeatMul);
        actor.relicLastTargetIds = curIds;
      }
      // 灼烂歼鬼（琴里专属）：对单体使用群体技能时伤害 1.5 倍
      if (exc.kotoriSingleAoeMul && targets.length === 1) {
        const et = Number(cfg.effType);
        if (EFF_FOE_ALL.has(et) || EFF_ANY_COL.has(et) || EFF_ANY_ROW.has(et) || et === 3007) {
          relicDmgMul *= (1 + exc.kotoriSingleAoeMul);
        }
      }
      // 平板电脑（白专属）：延时类技能伤害 +6%
      if (exc.shiroDelayMul && isDelaySkill(cfg.id)) relicDmgMul *= (1 + exc.shiroDelayMul);
      // 北京烤鸭（誓灵专属）：对中毒或烧伤目标伤害 +3%
      if (exc.duckVsAbnormal && t.buffs && (t.buffs[BUFF_IDS.POISON] || t.buffs[BUFF_IDS.BURN])) {
        relicDmgMul *= (1 + exc.duckVsAbnormal);
      }
    }
    // 小电视（17008003 通用段）：弹幕类技能伤害 +15%（此前标记零消费，2026-10-25 接线）
    if (miscEx && miscEx.danmakuDmgMul && isDanmakuSkill(cfg.id)) relicDmgMul *= (1 + miscEx.danmakuDmgMul);
    // 提比（17030004 通用段）：「其余己方角色造成伤害提升5%」——场上存活的携带者给除自己外的己方增伤
    if (allUnits && allUnits.length) {
      let allyRelicUp = 0;
      for (const x of allUnits) {
        if (x && x.hp > 0 && x.side === actor.side && x.id !== actor.id && x.relicMisc && x.relicMisc.allyDmgUp) {
          allyRelicUp += x.relicMisc.allyDmgUp;
        }
      }
      if (allyRelicUp) relicDmgMul *= (1 + Math.min(0.5, allyRelicUp));
    }
    // 活动助战·鸢一折纸（map_fight 开战时挂在敌人身上的通用易伤标记）：
    // 「敌方受到的首次伤害 +35%」。此处已在命中判定之后（miss 早在 1370 行 return），
    // 所以打空不会浪费标记；命中即消耗 ⇒ 多段/群攻只第一段吃到。
    // 标记由 map_fight.applyAssistVuln 挂载，fight_core 只认 t.assistFirstHitVuln，不依赖助战系统。
    let assistFirstHitMul = 1.0;
    if (t.assistFirstHitVuln && t.side !== actor.side && Number(cfg.power) > 0) {
      assistFirstHitMul = 1 + t.assistFirstHitVuln;
      t.assistFirstHitVuln = 0;
    }
    // 元素唤醒：克制伤害 +15%~30%（**最终 rel==1 才算**，放这里是因为上方各种天赋会改写 rel）；
    // 「下次攻击伤害提升」= 辅助技给全队挂的一次性乘区，命中即消耗
    let elementWeekMul = 1.0;
    let elementNextMul = 1.0;
    const elOwn = elAwake && (!Number(elAwake.servantType) || Number(elAwake.servantType) === Number(actor.type));
    if (elOwn && Number(cfg.power) > 0) {
      if (rel === 1) elementWeekMul = 1 + EL.strengthenOf(elAwake.lv)[0] / 100;
      if (Number(actor.elementNextAtkBonus) > 0) {
        elementNextMul = 1 + Number(actor.elementNextAtkBonus);
        actor.elementNextAtkBonus = 0;
      }
    }
    // P3-B/C 专属乘区（二百二十七/二十八）+ 连发追加倍率
    let exclusiveMul = 1.0;
    if (elOwn && Number(cfg.power) > 0 && elementExclusiveOf(actor, cfg.id)) {
      exclusiveMul = exclusiveDmgMulOf(actor, cfg, t, { curWeather, bst: battleState, units: allUnits });
      if (Number(actor.exclusiveRefireMul) > 1) {
        exclusiveMul *= Number(actor.exclusiveRefireMul);
        actor.exclusiveRefireMul = 0;
      }
    }
    let exclusiveOutInMul = 1.0;
    if (Number(cfg.power) > 0) {
      // 兴奋的秘泉（10168）：被祝福者造成的伤害翻倍（3回合；乘区与其它专属乘区同层）
      if ((actor.exciteSpringRounds || 0) > 0) exclusiveOutInMul *= (Number(actor.exciteSpringDmgMul) || 2.0);
      if (Number(actor.nextOutDmgUp) > 0) { exclusiveOutInMul *= 1 + Number(actor.nextOutDmgUp); actor.nextOutDmgUp = 0; }
      // 10216 星之传承：2 回合内己方伤害提升
      if ((actor.teamDmgUpRounds || 0) > 0) exclusiveOutInMul *= 1 + (Number(actor.teamDmgUpPct) || 0) / 100;
      if (actor.nextRoundDmgUpRound === (battleState && battleState.round) && Number(actor.nextRoundDmgUp) > 0) {
        exclusiveOutInMul *= 1 + Number(actor.nextRoundDmgUp);
      }
      if (Number(actor.nextOutDmgDown) > 0) { exclusiveOutInMul *= 1 - Math.min(1, Number(actor.nextOutDmgDown)); actor.nextOutDmgDown = 0; }
      if (Number(t.nextInDmgDown) > 0) { exclusiveOutInMul *= 1 - Math.min(1, Number(t.nextInDmgDown)); t.nextInDmgDown = 0; }
      if ((actor.lightDmgUpRounds || 0) > 0 && Number(cfg.nature) === 5) exclusiveOutInMul *= 1.5;
      if ((actor.nightFeastRounds || 0) > 0 && curWeather === WEATHER_IDS.NIGHT) {
        const darks = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.nature === 6).length;
        exclusiveOutInMul *= 1 + 0.5 * darks;
      }
      if ((actor.fleshBoostRounds || 0) > 0) exclusiveOutInMul *= 1.30;
      if ((t.fleshBoostRounds || 0) > 0) exclusiveOutInMul *= 0.70;
      if ((actor.skyGiftStacks || 0) > 0 && cfg.id === 10307) exclusiveOutInMul *= 1 + 0.04 * actor.skyGiftStacks; // 诸天主宰：每层天之赐+4%
      if ((t.magicBarrierRounds || 0) > 0 && cfg.type === 2) exclusiveOutInMul *= (Number(t.magicBarrierMul) > 0 ? Number(t.magicBarrierMul) : 0.50); // 法力屏障
      if ((t.phyBarrierRounds || 0) > 0 && cfg.type === 1) exclusiveOutInMul *= (Number(t.phyBarrierMul) > 0 ? Number(t.phyBarrierMul) : 0.50); // 力量屏障（物理）
      if (skillRule && skillRule.dmgMulBelowHalf && t.hp < t.maxHp * 0.5) exclusiveOutInMul *= skillRule.dmgMulBelowHalf; // 10130 基础：半血以下威力翻倍
      if (skillRule && skillRule.dmgMulByNature && (skillRule.dmgMulByNature.natures || []).includes(Number(t.nature))) {
        exclusiveOutInMul *= skillRule.dmgMulByNature.mul || 1.6;
      }
      if (skillRule && skillRule.dmgMulByShieldPct && (Number(actor.shield) || 0) > 0) {
        exclusiveOutInMul *= 1 + (Number(actor.shield) || 0) / (actor.maxHp || 1);
      }
      if (skillRule && skillRule.dmgMulIfTargetHpAboveActorMagAtk && t.hp > ((actor.attrs && actor.attrs.mag_atk) || 0)) {
        exclusiveOutInMul *= skillRule.dmgMulIfTargetHpAboveActorMagAtk;
      }
      if (skillRule && skillRule.dmgMulFixed) exclusiveOutInMul *= skillRule.dmgMulFixed;
      // 燃点引爆（20800）易燃消费：易燃状态下受到火属性伤害增加50%（自定口径：受火伤即引爆解除）
      if (t.flammable && Number(cfg.nature) === 2) {
        exclusiveOutInMul *= 1.5;
        t.flammable = false;
      }
      // 独眼暴乱者（21570）记仇消费：下次攻击对象若是伤害来源者，对其伤害提升100%（一次性）
      if (actor.talent === 21570 && Number(t.id) === Number(actor.cyclopsGrudgeId)) {
        exclusiveOutInMul *= 2.0;
        actor.cyclopsGrudgeId = null;
      }
      // 百炼之拳（10179）基础版：若使用者上回合被攻击技能伤害，伤害提升30%（优先度+1 在 SKILL_PRIO_TABLE）
      if (skillRule && skillRule.dmgMulIfHitLastRound && actor.hitByAtkLastRound) {
        exclusiveOutInMul *= skillRule.dmgMulIfHitLastRound;
      }
      // 沧海遗泪（10258）：本回合敌方每对自己造成一次伤害，该技能伤害提升50%
      if (skillRule && skillRule.dmgMulPerHitTakenThisRound && (actor.hitsTakenThisRound || 0) > 0) {
        exclusiveOutInMul *= 1 + skillRule.dmgMulPerHitTakenThisRound * actor.hitsTakenThisRound;
      }
      // —— 批次G-2 乘区族（二百五十六）——
      // 冥渊的门卫（20270 刻耳柏洛斯）：生命低于30%时，自身造成的伤害 ×0.65（物攻魔攻 -35% 折算）
      if (actor.talent === 20270 && actor.hp < actor.maxHp * 0.30) exclusiveOutInMul *= 0.65;
      // 山之鬼/川之鬼（20460 魑魅 / 20470 魍魉）：互为对方在场时各自增伤（物攻物防 / 魔攻魔防 ×1.5 折算为伤害 ×1.2）
      if (actor.talent === 20460 && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 20470)) {
        exclusiveOutInMul *= 1.2;
      }
      if (actor.talent === 20470 && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 20460)) {
        exclusiveOutInMul *= 1.2;
      }
      // 雨中的圆舞（20580 河童）：雨天时魔攻 ×1.5（速度在 effectiveSpeed）
      if (actor.talent === 20580 && curWeather === WEATHER_IDS.RAIN) exclusiveOutInMul *= 1.5;
      // 不给糖就捣蛋（20690 杰克南瓜）：对携带圣器的目标伤害后随机一项+1；无圣器则使其-1（后处理在受击段）
      // 束缚绞首（20910 络新妇）：攻击本回合未行动目标时伤害提升50%
      if (actor.talent === 20910 && !t.actedThisRound) exclusiveOutInMul *= 1.5;
      // 雪靴女神（21450 斯卡娣）：攻击本回合已行动目标 → 自身速度命中 +1（后处理在受击段）
      // 灭绝毒素（20260 海德拉）：自身中毒时伤害提升70%；对中毒状态目标伤害翻倍
      if (actor.talent === 20260) {
        if (actor.buffs && actor.buffs[BUFF_IDS.POISON]) exclusiveOutInMul *= 1.7;
        if (t.buffs && t.buffs[BUFF_IDS.POISON]) exclusiveOutInMul *= 2.0;
      }
      // 海妖之歌（20320 塞壬）：声音类技能威力提升50%
      if (actor.talent === 20320 && isSoundSkill(cfg.id)) exclusiveOutInMul *= 1.5;
      // 英勇之心（20280 伊阿宋）：攻击类技能的正面追加效果消失，技能威力提升50%
      // （"正面追加效果消失"在 applySkillEffects 里按 skillSuppressed 拦截）
      if (actor.talent === 20280 && Number(cfg.type) !== 3) {
        exclusiveOutInMul *= 1.5;
        actor.suppressPositiveAddOn = true;
      }
      // 「对被阻挡目标威力提升」族（批次G-3，二百五十六）：官方无「阻挡」状态（三路取证见调研文档 §2），
      // 近似口径 =「目标本回合已行动」（actedThisRound）。6 条技共用 dmgMulVsActed。
      if (skillRule && skillRule.dmgMulVsActed && t.actedThisRound) {
        exclusiveOutInMul *= skillRule.dmgMulVsActed;
      }
      // 疾走之风/其他「按速度差增伤」：风神破-疾（10049）速度越高威力越高（每点速度差 +1%，上限 +50%）
      if (skillRule && skillRule.dmgMulBySpeedDiff) {
        const diff = (effectiveSpeed(actor, allUnits, battleState) - effectiveSpeed(t, allUnits, battleState));
        if (diff > 0) exclusiveOutInMul *= 1 + Math.min(0.50, diff / Math.max(1, effectiveSpeed(t, allUnits, battleState)));
      }
      if (skillRule && skillRule.dmgMulIfAimsAt && battleState && battleState.selMap) {
        // 10331 基础版：目标的攻击意图（selMap[目标id] = 其主目标）指向 rule.types 里的誓灵 → 伤害提升
        const aimId = Number(battleState.selMap[t.id]);
        if (aimId) {
          const aimUnit = (allUnits || []).find(u => Number(u.id) === aimId);
          if (aimUnit && (skillRule.dmgMulIfAimsAt.types || []).includes(Number(aimUnit.type))) {
            exclusiveOutInMul *= skillRule.dmgMulIfAimsAt.mul;
          }
        }
      }
      if (skillRule && skillRule.dmgMulByEnemyMissingHp) {
        const alive = (allUnits || []).filter(a => a && a.hp > 0 && a.side !== actor.side);
        const avg = alive.length ? alive.reduce((s2, a) => s2 + Math.max(0, 1 - a.hp / (a.maxHp || 1)), 0) / alive.length : 0;
        exclusiveOutInMul *= 1 + avg;
      }
      if (skillRule && skillRule.dmgMulIfTargetStatSumPositive) {
        const ps = [101, 102, 103, 104, 105].reduce((s2, p2) => s2 + ((t.statLevels && t.statLevels[p2]) || 0), 0);
        if (ps > 0) exclusiveOutInMul *= skillRule.dmgMulIfTargetStatSumPositive;
      }
      if (skillRule && skillRule.dmgMulByNegativeStatSum) {                                                              // 10204 基础：负总和增伤
        const ns = [101, 102, 103, 104, 105].reduce((s2, p) => s2 + ((t.statLevels && t.statLevels[p]) || 0), 0);
        if (ns < 0) exclusiveOutInMul *= (curWeather === WEATHER_IDS.NIGHT ? skillRule.dmgMulByNegativeStatSum.night : skillRule.dmgMulByNegativeStatSum.base);
      }
      // —— 批次H1 乘区族 ——
      // 时序之风（10403）：对能力等级全部为0的目标伤害+50%（严格口径：五项基础等级全 0）
      if (skillRule && skillRule.dmgMulIfTargetStatSumZero) {
        const allZero = [101, 102, 103, 104, 105].every(p2 => ((t.statLevels && t.statLevels[p2]) || 0) === 0);
        if (allZero) exclusiveOutInMul *= skillRule.dmgMulIfTargetStatSumZero;
      }
      // 回溯之剑（10209）：上回合受到过来自该目标的技能伤害 → 对其伤害+35%
      //（hitFromThisRound 受击时按来源记录，回合末快照为 hitByFromLastRound）
      if (skillRule && skillRule.dmgMulIfHitByTargetLastRound && actor.hitByFromLastRound && actor.hitByFromLastRound[t.id]) {
        exclusiveOutInMul *= skillRule.dmgMulIfHitByTargetLastRound;
      }
      // 时越狙击（10211）：上回合对该目标造成过伤害 → 伤害+25%（per-target 轮询，round 门控过期自失效）
      if (actor.nextRoundDmgUpVs && actor.nextRoundDmgUpVs[t.id]
          && actor.nextRoundDmgUpVs[t.id].round === (battleState ? Number(battleState.round) : 0)) {
        exclusiveOutInMul *= 1 + Number(actor.nextRoundDmgUpVs[t.id].pct);
      }
      // 演剧部之声（10311）：场上每存在一名 clannad 阵营誓灵（含敌方）伤害+20%
      if (skillRule && skillRule.dmgMulPerClannad) {
        const cn = (allUnits || []).filter(u => u && u.hp > 0 && isClannad(u.type)).length;
        if (cn > 0) exclusiveOutInMul *= 1 + skillRule.dmgMulPerClannad * cn;
      }
      // 囚世地牢（10415）：目标是敌方场地生命最高者 → 伤害+30%
      if (skillRule && skillRule.dmgMulIfTargetTopHp) {
        const foesAlive = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
        const topHp = foesAlive.reduce((m, u) => Math.max(m, u.hp), 0);
        if (t.hp >= topHp) exclusiveOutInMul *= skillRule.dmgMulIfTargetTopHp;
      }
      // 舍命奋进（10398）：自身本回合受到伤害提升40%（通用 inDmgUpRounds 通道，受方立场）
      if ((t.inDmgUpRounds || 0) > 0) exclusiveOutInMul *= 1 + (Number(t.inDmgUpPct) || 0);
      // 10375 圣甲虫护壳：己方 3 回合内受到伤害降低（teamDmgDownRounds/Pct）
      if ((t.teamDmgDownRounds || 0) > 0) exclusiveOutInMul *= 1 - Math.min(1, (Number(t.teamDmgDownPct) || 0) / 100);
      // 10253 王座的守护：本回合受到伤害 -25%
      if ((t.inDmgDownRounds || 0) > 0) exclusiveOutInMul *= 1 - Math.min(1, (Number(t.inDmgDownPct) || 0) / 100);
      // 10323 永恒解脱：开启期间自身伤害 ×4
      if ((actor.eternalReleaseRounds || 0) > 0) exclusiveOutInMul *= (Number(actor.eternalReleaseDmgMul) || 4);
      // 10414 无上宽恕：5 回合内造成伤害 +n×10%
      if ((actor.forgiveDmgRounds || 0) > 0) exclusiveOutInMul *= 1 + (Number(actor.forgiveDmgPct) || 0);
      // 元素融合（10173）：克制伤害提升30%（同属性修正在 same 段消费）
      if (actor.fusionActive && rel === 1) exclusiveOutInMul *= 1.3;
      // 弱者的反击（10266）：施放时按降低的等级数一次性增伤（本次行动全程有效，行动开始时已重置）
      if (actor.selfDropDmgBonus > 1) exclusiveOutInMul *= actor.selfDropDmgBonus;
      if (cfg.id === 10029 && actor.type === 1341001) exclusiveOutInMul *= 1; // 黄泉逆流的分支在施放侧
    }
    if (cfg.id === 10362 && rel === 1 && elementExclusiveOf(actor, cfg.id)) exclusiveOutInMul *= 1.3;      // 小矮人救援：克制伤害+30%
    if (cfg.id === 10363 && elementExclusiveOf(actor, cfg.id) && actor.buffs && actor.buffs[BUFF_IDS.SLEEP]) exclusiveOutInMul *= 1.6; // 梦游仙境：睡眠中伤害+60%
    let exclusiveCritMul = 1.0;
    if (cfg.id === 10408 && crit && rel === 1 && (Number(t.nature) === 1 || Number(t.nature) === 2) && elementExclusiveOf(actor, cfg.id)) {
      exclusiveCritMul = 1.4; // 绿葱蘸酱：对水火暴击伤害+40%
    }
    // P4 基础规则：造成克制时提升能力（10408/10362）—— 放在 rel 定稿之后
    if (skillRule && skillRule.onResistStat && rel === 1 && actor.hp > 0) {
      const os = skillRule.onResistStat;
      if (os.prop) gainStat(actor, os.prop, os.delta || 1, { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
      if (os.higherAtk) gainStat(actor, (actor.attrs && actor.attrs.phy_atk >= actor.attrs.mag_atk) ? 101 : 102, os.higherAtk, { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
      if (os.speed) gainStat(actor, 105, os.speed, { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
      if (os.randomDef) gainStat(actor, Math.random() < 0.5 ? 103 : 104, os.randomDef, { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    }
    // 虎儿圣器（虎儿专属）：造成克制伤害时随机 1 项防御 +1 级
    if (rel === 1 && actor.hp > 0 && actor.relicMisc && actor.relicMisc.excl && actor.relicMisc.excl.tigerWeekDefUp) {
      const twProp = Math.random() < 0.5 ? 103 : 104;
      gainStat(actor, twProp, 1, { effects: wakeEffects, srcId: PROP_FEATURE_IDS[twProp], atkId: actor.id, srcServantId: actor.id, phase });
    }
    // 绝灭天使（折纸专属）：克制倍率由 1.75 变为 1.95（只影响攻击方自己的克制倍率）
    const exclA1 = actor.relicMisc && actor.relicMisc.excl;
    const weekPer = (rel === 1 && exclA1 && exclA1.origamiWeekPer) ? exclA1.origamiWeekPer : naturePer(rel);
    let hurt = lvTerm * (effPower * aphroditePowerMul * atk) / safeDef * sameMul * weekPer * roll
      * (crit ? effectiveCritMul * exclusiveCritMul : 1) * (1 + (actor.dmgMul || 0)) * (1 + natM) * (1 + wkM) * relicDmgMul * assistFirstHitMul
      * elementWeekMul * elementNextMul * exclusiveMul * exclusiveOutInMul
      * weatherDmgMul * talentNatureDmgMul * (1 + ((talentRuleOf(t.talent) || {}).takenBonus || 0))
      * luciferMul * aresMul * yogMul * matsuriMul * origamiAtkMul * zhuqueBoost * zhuqueVulnMul * kunWaterMul
      * yanheMul * artemisMul * xingciMul * soundBoostMul * kotoriFireMul * tomoyoMul * fubukiMul * aquaMul * yumemiMul * jibrilMul
      * cxaoghaAtkMul * machaMul * xiheMul * sethMul * lughAtkMul * athenaMul * demeterMul * osirisMul
      * vedrfolnirMul * helDarkMul * suserihimeMul * ookuniTakamaMul * michaelMul * haemosuMul * matchGirlMul * varunaWaterMul * horusWindMul * aphroditeSameMul * yamaMul * generalCurrDmgMul * raAoeBonusMul
      * iceQueenMul * sleepBeautyMul * nemainMul * friggaMul * xuanwuMul * hwanungMul * somaMul * meaMul * yanwoMul * taiyakiMul * chinoAllyDmgMul * chinoSelfDmgMul * syaroMul * nutCurseVuln * peaVulnMul * lancelotMul * yinglongMul * sobekMul * sagittariusAtkMul * xiziMul * yinMul * cthyllaAtkMul * yaojiMitMul
      * arahabakiPowerMul * hadesMul * hodurMul * surtrMul * astraeaMul * samaelMul * asmodeusMul * sharayahMul * sekhmetMul * persephoneSupportMul * persephoneDarkMul * basiliskMul * epimetheusMul * erosMul * redHoodMul * zhurongMul * gonggongMul * heraclesMul * ptahMul * baldrDarkMul * urdMul * verdandiMul * changeMul
      * xiaozhouMul * ziMul * chouMul * shenMul * youMul * xuMul * aquariusMul * electricTwinsMul
      * itaquaMul * makaraMul * asuraMul * forsetiVulnMul
      * (1 - Math.min(0.9, mit + talentMit + origamiDefMit + aliceSleepMit + chitoMit + cxaoghaDefMit + athenaMit + lughDefMit + suserihimeMit + haemosuMit + nianMit + yamaMit + lotusMit + friggaMit + hwanungMit + arthurMit + chinoAllyMit + chinoSelfMit + sagittariusDefMit + belphegorMit + leizuMit + baldrMit + nakizawaSelfMit + nakizawaTeamMit + seleneMit + chenFireMit + capricornMit + piscesMit + geminiMit + leoMit + dhrtarastraMit + itaquaAoeMit + makaraMit + irisMit)) * (1 - awk) * relicTakenMul;
    hurt = Math.max(1, Math.round(hurt + extraShieldDmg + heraTrueDmg));

    // —— 批次A天赋模板族（二百五十一）——
    // 属性吸收族（20060光/20080暗/20190水/20310土/20360风/20900热能）：受到对应属性技能攻击时
    // 「不会受到伤害，回复最大HP的25%」；浴火（20430）：不受伤且魔攻+1（无回复段）。
    // 全吸收=伤害归零 ⇒ 必须在受创反应链（hurt>0 守卫）之前置零，护盾/击杀/反馈全不触发。
    const absorbNature = ABSORB_TALENT_NATURE[t.talent];
    if (absorbNature != null && Number(cfg.nature) === absorbNature && hurt > 0) {
      hurt = 0;
      wakeEffects.push({ // 天赋横幅（change_type 0 只出名称提示）
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: t.talent, id: t.talent, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
      if (t.talent === 20430) {
        gainStat(t, 102, 1, { effects: wakeEffects, srcId: 20430, atkId: actor.id, srcServantId: t.id, phase });
      } else {
        const heal = Math.max(1, Math.floor((t.maxHp || (t.attrs && t.attrs.hp) || t.hp) * 0.25));
        t.hp = Math.min(t.maxHp, t.hp + heal);
        wakeEffects.push({ // change_type 200000 正值=治疗（客户端 FeatureLoop 取负显示）
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: t.talent, id: t.talent, effect_phase: phase,
          change_type: 200000, change_value: [heal], remove_round: 0,
        });
      }
    }
    // 秘密弱点（20480）：受到水、风属性技能伤害减半，受到火属性技能伤害翻倍
    if (t.talent === 20480 && hurt > 0) {
      if (Number(cfg.nature) === 1 || Number(cfg.nature) === 3) hurt = Math.max(1, Math.round(hurt * 0.5));
      else if (Number(cfg.nature) === 2) hurt = Math.round(hurt * 2);
    }
    // 蠕动装甲（22570 修格斯）：若攻击方的攻击力低于修格斯的防御力，只会造成50%的伤害（登场+1双防在进场段）
    if (t.talent === 22570 && hurt > 0 && Number(atk) < Number(def)) {
      hurt = Math.max(1, Math.round(hurt * 0.50));
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 22570, id: 22570, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    }

    // 拇指姑娘（22770 万花）：受创消耗1颗生命之种降低40%伤害并恢复15%生命
    if ((t.lifeSeeds || 0) > 0 && hurt > 0) {
      t.lifeSeeds--;
      hurt = Math.max(1, Math.round(hurt * 0.60));
      const heal = Math.max(1, Math.floor(t.maxHp * 0.15));
      t.hp = Math.min(t.maxHp, t.hp + heal);
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 22770,
        id: 22770,
        effect_phase: phase,
        change_type: 200000,
        change_value: [-heal],
        remove_round: 0,
      });
      // 三百一十三：种子层数同步（60120 showName=0 静默——回血横幅已由上一条 22770 播放）；
      // 归零走 300020 摘图标（客户端不自治过期）
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
        change_type: (t.lifeSeeds || 0) > 0 ? 300019 : 300020,
        change_value: [(t.lifeSeeds || 0) > 0 ? encodeBuffVal(22770, t.lifeSeeds) : 22770],
        remove_round: 0,
      });
    }

    // =========================================================================
    // SR 阶段二（Phase 2）受创后反应
    // =========================================================================
    // 41. 苏利耶（23180 光由天成）：反馈本回合受到的第一次光系技能伤害至攻击者
    if (t.talent === 23180 && cfg.nature === 5 && hurt > 0 && actor.hp > 0) {
      if (!t.suryaReflectedThisRound) {
        t.suryaReflectedThisRound = true;
        const reflect = Math.max(1, Math.round(hurt * 0.50));
        actor.hp = Math.max(1, actor.hp - reflect);
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
          src_servant_id: t.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 23180,
          id: 23180,
          effect_phase: phase,
          change_type: 200000,
          change_value: [-reflect],
          remove_round: 0,
        });
      }
    }

    // 43. 拉贵尔（23230 神之友）：己方誓灵被攻击后，其较高攻击等级提升1级
    if (hurt > 0 && (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 23230)) {
      const prop = (t.attrs && t.attrs.phy_atk >= t.attrs.mag_atk) ? 101 : 102;
      t.statLevels = t.statLevels || {};
      const oldLv = t.statLevels[prop] || 0;
      const newLv = Math.min(6, oldLv + 1);
      const delta = newLv - oldLv;
      t.statLevels[prop] = newLv;
      const an = PROP_ATTR_NAMES[prop];
      if (an) t[an] = newLv;
      if (delta > 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 23230,
          id: 23230,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, delta, newLv)],
          remove_round: 0,
        });
      }
    }

    // 苏摩（23140 永生血酒）：受直接技能伤害消耗1层血铠锁为1点伤害，全队升较高攻与随机防1级
    if (t.talent === 23140 && (t.bloodArmorLayers || 0) > 0 && hurt > 1) {
      t.bloodArmorLayers--;
      hurt = 1;
      // 三百一十三：血铠消耗后层数同步（归零走 300020 摘图标）
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
        change_type: (t.bloodArmorLayers || 0) > 0 ? 300019 : 300020,
        change_value: [(t.bloodArmorLayers || 0) > 0 ? encodeBuffVal(23140, t.bloodArmorLayers) : 23140],
        remove_round: 0,
      });
      const somaAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side);
        somaAllies.forEach(a => {
          const higherAtkProp = ((a.attrs && a.attrs.phy_atk) >= (a.attrs && a.attrs.mag_atk)) ? 101 : 102;
          const randDefProp = rnd() < 0.5 ? 103 : 104;
          [higherAtkProp, randDefProp].forEach(p => {
            gainStat(a, p, 1, { effects: wakeEffects, srcId: 23140, atkId: t.id, srcServantId: t.id, phase });
          });
        });
    }

    // 豌豆公主（23250 散华）：受单体技能伤害仅扣1血，余伤队友均摊
    // （均摊扣血必须下发 200000 负值，否则队友客户端血条不同步——克塔亚特 22790 同款）
    if (t.talent === 23250 && isSingleFoe && targets.length === 1 && hurt > 1) {
      const teammates = (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side && u.id !== t.id);
      if (teammates.length > 0) {
        const excess = hurt - 1;
        hurt = 1;
        const share = Math.floor(excess / teammates.length) || 1;
        teammates.forEach(tm => {
          const tmHpBefore = tm.hp;
          tm.hp = Math.max(0, tm.hp - share);
          if (tm.hp < tmHpBefore) {
            wakeEffects.push({
              trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [tm.id],
              src_type: 1, src_id: 23250, id: 23250, effect_phase: phase,
              change_type: 200000, change_value: [-(tmHpBefore - tm.hp)], remove_round: 0,
            });
          }
        });
      }
    }

    // 克塔亚特（22790 接触融合）：克塔亚特受到的直接技能伤害与融合目标分摊
    // （官方口径：她留 50%，其余 50% 均摊给天赋绑定（cthyllaBound*）的存活敌方；分摊直改 HP 不再触发二次分摊）
    if (t.talent === 22790 && hurt > 1) {
      const bound = (allUnits || []).filter(u => u && u.hp > 0 && u.id !== t.id
        && (u.cthyllaBoundRounds || 0) > 0 && Number(u.cthyllaBoundUnitId) === Number(t.id));
      if (bound.length) {
        const splitAmt = Math.floor(hurt * 0.50);
        if (splitAmt > 0) {
          hurt -= splitAmt;
          const share = Math.max(1, Math.floor(splitAmt / bound.length));
          bound.forEach(v => {
            v.hp = Math.max(0, v.hp - share);
            wakeEffects.push({ // 22791 带 act=20651：客户端播接触融合动画；一条一目标（D9）
              trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [v.id],
              src_type: 1, src_id: 22790, id: 22791, effect_phase: phase,
              change_type: 200000, change_value: [-share], remove_round: 0,
            });
          });
        }
      }
    }

    // 护盾吸收
    let shieldHurt = 0;
    // 小提琴（琴美专属）：群体技能无视结界盾（护盾）
    const kotomiIgnoreShield = !!(actor.relicMisc && actor.relicMisc.excl && actor.relicMisc.excl.kotomiAoeIgnoreShield
      && (Number(cfg.effType) === 3007 || EFF_FOE_ALL.has(Number(cfg.effType)) || EFF_ANY_COL.has(Number(cfg.effType)) || EFF_ANY_ROW.has(Number(cfg.effType))));
    if (t.shield > 0 && !kotomiIgnoreShield) {
      const oldShield = t.shield;
      shieldHurt = Math.min(t.shield, hurt);
      t.shield -= shieldHurt;
      hurt -= shieldHurt;
      // 玉子烧（23120 软绵回忆）：失去护盾时随机提升2项能力等级1级
      if (oldShield > 0 && t.shield <= 0 && t.talent === 23120) {
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const idx1 = Math.floor(rnd() * props.length);
        const p1 = props[idx1];
        const remainingProps = props.filter((_, idx) => idx !== idx1);
        const p2 = remainingProps[Math.floor(rnd() * remainingProps.length)];
        [p1, p2].forEach(p => {
          gainStat(t, p, 1, { effects: wakeEffects, srcId: 23120, atkId: t.id, srcServantId: t.id, phase });
        });
      }
    }
    // P3 反核弹外壳（10372）：本回合首次受到的伤害降至 1，并把初始伤害反弹给攻击者
    if (t.firstHitTo1 && hurt > 0) {
      const orig = hurt;
      hurt = 1;
      t.firstHitTo1 = false;
      if (actor && actor.hp > 0) {
        const back = Math.max(1, Math.round(orig));
        actor.hp = Math.max(0, actor.hp - back);
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [actor.id],
          src_type: 3, src_id: 10372, id: 60120, effect_phase: phase,
          change_type: 200000, change_value: [-back], remove_round: 0,
        });
      }
    }
    // 10323 永恒解脱：解脱状态下被魔攻技能攻击必定被击倒（护盾吸收后按剩余生命强制归零）
    if (t.eternalReleased && Number(cfg.type) === 2 && hurt > 0) hurt = Math.max(hurt, t.hp);
    // 10399 瑶草：本回合受到的直接技能伤害反馈给攻击者。
    // 不在敌方行动里追加 result（否则客户端会把整段技能动画聚焦到攻击者），
    // 由 map_fight 读取 reflectEvents 后生成一条独立行动（伤害数字/HP 同步）。
    if ((t.reflectDirectRounds || 0) > 0 && hurt > 0 && actor && actor.hp > 0) {
      const back = Math.max(1, Math.round(hurt));
      actor.hp = Math.max(0, actor.hp - back);
      if (!results.reflectEvents) results.reflectEvents = [];
      results.reflectEvents.push({ from: t.id, to: actor.id, amount: back, skillId: cfg.id });
    }
    // 2026-10-27：落账前快照。此行之后到落账为止的 t.hp 直改（暗夜主宰10336吸血/仇恨吸引
    // 回血/狼人20870回血/亥22100盾回/阿修罗22720回血/乌波萨斯拉21880回血/八咫乌21390与
    // 迦楼罗22730追加伤害）会被落账行覆盖——玉兔22950同源陷阱（2026-10-12 只修了玉兔自己，
    // 探针 tmp/probe_void_zone.js 实证狼人 +100 治疗演出发了但终值没吃到），落账处统一并回。
    const preLandHp = t.hp;
    let after = Math.max(0, t.hp - hurt);

    // 120. 加拉哈德（22650 圣杯骑士）：受到致死伤害后生命值恢复至60%且全能力提升至+2（每场限一次）
    if (after <= 0 && t.talent === 22650 && !t.galahadRevived) {
      t.galahadRevived = true;
      after = Math.max(1, Math.round(t.maxHp * 0.60));
        [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
          const oldLv = (t.statLevels && t.statLevels[p]) || 0;
          if (oldLv < 2) {
            gainStat(t, p, 2 - oldLv, { effects: wakeEffects, srcId: 22650, atkId: t.id, srcServantId: t.id, phase });
          }
        });
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 22650,
        id: 22650,
        effect_phase: phase,
        change_type: 200000,
        change_value: [after],
        remove_round: 0,
      });
    }

    // 奥西里斯（20930 冥界归还）：己方队友受到致命伤害时保留1点生命，本回合结束时力尽
    if (after <= 0 && t.hp > 0 && !t.pendingFaint) {
      const osirisAlly = (allUnits || []).find(u => u && u.hp > 0 && u.side === t.side && u.id !== t.id && u.talent === 20930);
      if (osirisAlly) {
        after = 1;
        t.pendingFaint = true;
        t.osirisSavedBy = osirisAlly.id;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: osirisAlly.id,
          tar_servant_ids: [t.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 20930,
          id: 20930,
          effect_phase: phase,
          change_type: 0,
          change_value: [],
          remove_round: 0,
        });
      }
    }

    // 圣器「致死抵挡」族（炸虾狮 17014004）：抵挡一次致死伤害并恢复到最大生命 20%（一场一次）。
    if (after <= 0 && t.hp > 0 && t.relicDeathGuard && !t.relicDeathGuardUsed) {
      t.relicDeathGuardUsed = true;
      after = Math.max(1, Math.round((t.maxHp || 1000) * t.relicDeathGuard));
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id,
        tar_servant_ids: [t.id], src_type: 1, src_id: 30531, id: 30531,
        effect_phase: phase, change_type: 200000, change_value: [after], remove_round: 0,
      });
    }
    // 圣器「濒死保命」族（气息之石Lv1-3 / 命运之石）：受到技能伤害使生命归零时，按概率留下 1HP。
    // CfgItems desc「有N%几率留下1HP」；飘字复用官方特性 30491/30501/30511/30521（#tar保留了1点生命）。
    // 放在奥西里斯之后：天赋优先，圣器作为独立保命手段（两者都不消耗对方的判定）。
    if (after <= 0 && t.relicDeathSave && t.relicDeathSave.chance > 0) {
      if (rnd() < t.relicDeathSave.chance) {
        after = 1;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: t.relicDeathSave.feature,
          id: t.relicDeathSave.feature,
          effect_phase: phase,
          change_type: 200000,
          change_value: [1],
          remove_round: 0,
        });
      }
    }
    // extra 位掩码：WEEK=8 (1<<3), RESIST=16 (1<<4), CRIT=2 (1<<1)
    let extra = rel === 1 ? FIGHT_EXTRA.WEEK : rel === 2 ? FIGHT_EXTRA.RESIST : 0;
    if (crit) extra |= FIGHT_EXTRA.CRIT;

    // 犹格索托斯（21910 虚空掌控）：技能吸血与虚空充能
    if (actor.talent === 21910 && hurt > 0) {
      // 吸血按"本击结算所依据的虚空"计：10273 用倾泻前快照（否则清空后当场失去吸血）
      const leechVoid = (voidBurst && actor.voidBurstSnapshot != null) ? actor.voidBurstSnapshot : (actor.void_energy || 0);
      const leechPct = leechVoid * 0.005;
      if (leechPct > 0) {
        const leechHeal = Math.min(actor.maxHp - actor.hp, Math.max(1, Math.round(hurt * leechPct)));
        if (leechHeal > 0) {
          actor.hp += leechHeal;
          wakeEffects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [actor.id],
            src_type: 1,
            src_id: 21910,
            id: 219107, // FightFeature[219107]：showName=0 + act=20015 回血动画（21910 本体无 tips/act，会全哑）
            effect_phase: phase,
            change_type: 200000,
            change_value: [leechHeal],
            remove_round: 0,
          });
        }
      }
      chargeVoid(actor, 10, wakeEffects, phase, actor.id, rnd);
      if (after <= 0) chargeVoid(actor, 10, wakeEffects, phase, actor.id, rnd); // 击败敌人额外+10
    }
    // =========================================================================
    // SR 阶段一（Phase 1）受创后反应
    // =========================================================================
    // 辉夜姬（20140 不可侵犯）：受到物理攻击伤害时，攻击者物攻下降2级
    if (t.talent === 20140 && cfg.type === 1 && hurt > 0 && actor.hp > 0) {
      actor.statLevels = actor.statLevels || {};
      const oldAtk = actor.statLevels[101] || 0;
      const newAtk = Math.max(-6, oldAtk - 2);
      const delta = newAtk - oldAtk;
      actor.statLevels[101] = newAtk;
      const an = PROP_ATTR_NAMES[101];
      if (an) actor[an] = newAtk;
      if (delta < 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
          src_servant_id: t.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 20140,
          id: 20140,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(101, delta, newAtk)],
          remove_round: 0,
        });
      }
    }

    // 克希拉（22800 附肢触须）：单次受伤超过10%生命时，己方全体角色获得一根附肢触须
    // （三百一十三：CfgBuff[22800]「附肢触须」7%/层 逐级显示——层数此前纯内部字段零下发）
    if (t.talent === 22800 && hurt > (t.maxHp * 0.10)) {
      const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side);
      allies.forEach(a => {
        const before = a.tentacleStacks || 0;
        a.tentacleStacks = Math.min(10, before + 1);
        if (a.tentacleStacks > before) {
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [a.id],
            src_type: 1, src_id: 22800, id: 22800, effect_phase: phase,
            change_type: 300019, change_value: [encodeBuffVal(22800, a.tentacleStacks)], remove_round: 0,
          });
        }
      });
    }

    // 诺登斯（22460 梦境狩猎者）：造成伤害陷入深层睡眠2回合，再次伤害解除
    // （三百一十三：CfgBuff[22460]「深层睡眠」带 eff 动画——施加/解除必须成对下发 300019/300020）
    if (actor.talent === 22460 && hurt > 0) {
      if ((t.deepSleepRounds || 0) > 0) {
        t.deepSleepRounds = 0;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
          change_type: 300020, change_value: [22460], remove_round: 0,
        });
      } else {
        (allUnits || []).forEach(u => {
          if (u && u.side === t.side) {
            if ((u.deepSleepRounds || 0) > 0) {
              wakeEffects.push({
                trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [u.id],
                src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
                change_type: 300020, change_value: [22460], remove_round: 0,
              });
            }
            u.deepSleepRounds = 0;
          }
        });
        t.deepSleepRounds = 2;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 22460, id: 22460, effect_phase: phase,
          change_type: 300019, change_value: [encodeBuffVal(22460, 1)], remove_round: 2,
        });
      }
    }

    // 克图格亚（21930 行走的太阳）：敌方受到暴击伤害时，己方对其暴击率提升20%可叠加
    if (crit && hurt > 0 && (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21930)) {
      t.cfluguaCritVulnStacks = (t.cfluguaCritVulnStacks || 0) + 1;
    }

    // =========================================================================
    // SR 阶段三（Phase 3）受创与技能后触发
    // =========================================================================
    // 52. 八咫乌（21390 日轮的神使）：火/光技能命中后追加最大生命6%伤害（烈日下12%）
    if (actor.talent === 21390 && hurt > 0 && (cfg.nature === 2 || cfg.nature === 5)) {
      const ratio = (curWeather === WEATHER_IDS.SUN) ? 0.12 : 0.06;
      const extra = Math.max(1, Math.round(t.maxHp * ratio));
      t.hp = Math.max(1, t.hp - extra);
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 21390,
        id: 21390,
        effect_phase: phase,
        change_type: 200000,
        change_value: [-extra],
        remove_round: 0,
      });
    }

    // 53. 酒吞童子（21400 大江山之鬼）：受击时敌方受到此次伤害30%反击（夜幕60%）
    if (t.talent === 21400 && t.shutenRage && hurt > 0 && actor.hp > 0) {
      const ratio = (curWeather === WEATHER_IDS.NIGHT) ? 0.60 : 0.30;
      const ret = Math.max(1, Math.round(hurt * ratio));
      actor.hp = Math.max(1, actor.hp - ret);
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 21400,
        id: 21400,
        effect_phase: phase,
        change_type: 200000,
        change_value: [-ret],
        remove_round: 0,
      });
    }

    // 45. 玉藻前（20650 杀生石）：被攻击时50%概率使攻击者被感染
    if (t.talent === 20650 && hurt > 0 && actor.hp > 0 && Math.random() < 0.50) {
      actor.infectedByTamamo = true;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 20650,
        id: 20650,
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      });
    }

    // 60. 八上比卖（22620 侧室的幽怨）：对目标造成伤害时叠加1层“哀叹”
    if (actor.talent === 22620 && hurt > 0) {
      t.lamentStacks = (t.lamentStacks || 0) + 1;
    }

    // 47. 诗寇蒂（20860 命运·未来）：记录本回合自身造成的伤害供下回合末爆发
    if (actor.talent === 20860 && hurt > 0) {
      actor.skuldDealtThisRound = (actor.skuldDealtThisRound || 0) + hurt;
    }

    // 46. 厄洛斯（20660 姻缘的箭矢）：敌方契约者攻击我方契约者后，较高一项攻击下降1级
    if (actor.erosContractWith === t.id && actor.erosContractRounds > 0 && hurt > 0) {
      const prop = (actor.attrs && actor.attrs.phy_atk >= actor.attrs.mag_atk) ? 101 : 102;
      actor.statLevels = actor.statLevels || {};
      const oldLv = actor.statLevels[prop] || 0;
      const newLv = Math.max(-6, oldLv - 1);
      const delta = newLv - oldLv;
      actor.statLevels[prop] = newLv;
      const an = PROP_ATTR_NAMES[prop];
      if (an) actor[an] = newLv;
      if (delta < 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
          src_servant_id: t.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 20660,
          id: 20660,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, delta, newLv)],
          remove_round: 0,
        });
      }
    }

    // =========================================================================
    // SR 阶段四（Phase 4）受创后反制
    // =========================================================================
    // 67. 建御雷（20770 战之血脉）：受到攻击伤害时物攻上升1~2级
    if (t.talent === 20770 && hurt > 0) {
      const up = 1 + Math.floor(Math.random() * 2);
      // atk 必须归因攻击者（客户端按 curEffData.atk_id 查动作桶；test_effect_attribution 动态断言）
      gainStat(t, 101, up, { effects: wakeEffects, srcId: 20770, atkId: actor.id, srcServantId: t.id, phase });
    }

    // 68. 鲛人（21810 泣珠）：受到攻击伤害时己方全队暴击等级+1
    if (t.talent === 21810 && hurt > 0) {
      (allUnits || []).forEach(a => {
        if (a && a.hp > 0 && a.side === t.side) {
          a.statLevels = a.statLevels || {};
          const oldLv = a.statLevels[111] || 0;
          const newLv = Math.min(6, oldLv + 1);
          const delta = newLv - oldLv;
          a.statLevels[111] = newLv;
          const an = PROP_ATTR_NAMES[111];
          if (an) a[an] = newLv;
          if (delta > 0) {
            wakeEffects.push({
              trigger_count: 0,
              atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
              src_servant_id: t.id,
              tar_servant_ids: [a.id],
              src_type: 1,
              src_id: 21810,
              id: 21810,
              effect_phase: phase,
              change_type: 100000,
              change_value: [encodeAttrVal(111, delta, newLv)],
              remove_round: 0,
            });
          }
        }
      });
    }

    // 72. 别西卜（22560 靡之就食者）：无护盾时受创将该次伤害的一半转化为护盾
    if (t.talent === 22560 && hurt > 0 && !(t.shield > 0)) {
      const converted = Math.max(1, Math.round(hurt * 0.50));
      t.shield = (Number(t.shield) || 0) + converted;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 22560,
        id: 22560,
        effect_phase: phase,
        // 2026-10-27：护盾必须走 200001（200000 正值客户端当回血播、盾不可见）
        change_type: 200001,
        change_value: [converted],
        remove_round: 0,
      });
    }

    // 70. 薇儿丹蒂（20850 命运·现在）：受创实际扣血的15%转化为护盾
    if (t.talent === 20850 && hurt > 0) {
      const shieldVal = Math.max(1, Math.round(hurt * 0.15));
      t.shield = (Number(t.shield) || 0) + shieldVal;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 20850,
        id: 20850,
        effect_phase: phase,
        // 2026-10-27：护盾必须走 200001（200000 正值客户端当回血播、盾不可见）
        change_type: 200001,
        change_value: [shieldVal],
        remove_round: 0,
      });
    }

    // 71. 狼人（20870 野性克制）：每受到两次技能伤害三维+1并恢复10%生命
    if (t.talent === 20870 && hurt > 0) {
      t.wolfHitCount = (t.wolfHitCount || 0) + 1;
      if (t.wolfHitCount >= 2) {
        t.wolfHitCount = 0;
        t.statLevels = t.statLevels || {};
        // 三维+1 必须逐项发 100000 属性 effect（id=20001/20003/20004，客户端表内、
        // tips="#tar的物攻/物防/魔防上升了#value级"）——只改数值不发 effect 玩家看不到任何反馈，
        // 观感即「被动没用」（2026-10-12 用户反馈实证）
        [101, 103, 104].forEach(p => {
          const oldLv = t.statLevels[p] || 0;
          const newLv = Math.min(6, oldLv + 1);
          t.statLevels[p] = newLv;
          const an = PROP_ATTR_NAMES[p];
          if (an) t[an] = newLv;
          wakeEffects.push({
            trigger_count: 0,
            atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
            src_servant_id: t.id,
            tar_servant_ids: [t.id],
            src_type: 1,
            src_id: 20870,
            id: PROP_FEATURE_IDS[p] || 20001,
            effect_phase: phase,
            change_type: 100000, // FIGHT_EFF_CHANGE_TYPE_ATTR
            change_value: [encodeAttrVal(p, 1)],
            remove_round: 0,
          });
        });
        const heal = Math.max(1, Math.round(t.maxHp * 0.10));
        t.hp = Math.min(t.maxHp, t.hp + heal);
        // 治疗展示条目：20870 在客户端 FightFeature 表无 tips（不飘字），改用 30531
        // 「回复的甘露」（act=20015 回血动画 + tips 带 #value）让回血可见
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 20870,
          id: 30531,
          effect_phase: phase,
          change_type: 200000,
          change_value: [heal],
          remove_round: 0,
        });
      }
    }

    // 81. 修普诺斯（22500 梦境破碎）：受创时清除敌方护盾并将睡眠转移给攻击者
    if (t.talent === 22500 && hurt > 0 && actor.hp > 0) {
      if (actor.shield > 0) {
        // 2026-10-27：清盾补 200001 负值增量，否则攻击者护盾条停在旧值
        const clearedShield = Math.round(actor.shield);
        actor.shield = 0;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [actor.id],
          src_type: 1, src_id: 22500, id: 22500, effect_phase: phase,
          change_type: 200001, change_value: [-clearedShield], remove_round: 0,
        });
      }
      actor.buffs = actor.buffs || {};
      actor.buffs[BUFF_IDS.SLEEP] = { level: 1, duration: 2 };
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id /* 修复：按 curEffData.atk_id 查桶 */,
        src_servant_id: t.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 22500,
        id: 22500,
        effect_phase: phase,
        change_type: 300019,
        change_value: [encodeBuffVal(BUFF_IDS.SLEEP, 1)],
        remove_round: 2,
      });
    }

    // 69. 兀尔德（20840 命运·过去）：造成伤害后回复上回合所受伤害的10%HP
    if (actor.talent === 20840 && hurt > 0 && actor.urdLastTakenDamage > 0) {
      const heal = Math.max(1, Math.round(actor.urdLastTakenDamage * 0.10));
      actor.hp = Math.min(actor.maxHp, actor.hp + heal);
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 20840,
        id: 20840,
        effect_phase: phase,
        change_type: 200000,
        change_value: [heal],
        remove_round: 0,
      });
    }

    // =========================================================================
    // SR 阶段五（Phase 5）受创后阵营生态反应
    // =========================================================================
    // 87. 摩羯座（21040 卑微的献身）：其余友方受单体伤害时，摩羯座承担20%伤害
    if (isSingleFoe) {
      const capricorns = (allUnits || []).filter(x => x && x.hp > 0 && x.side === t.side && x.id !== t.id && x.talent === 21040);
      capricorns.forEach(cap => {
        const share = Math.max(1, Math.round(hurt * 0.20));
        cap.hp = Math.max(1, cap.hp - share);
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: cap.id,
          tar_servant_ids: [cap.id],
          src_type: 1,
          src_id: 21040,
          id: 21040,
          effect_phase: phase,
          change_type: 200000,
          change_value: [-share],
          remove_round: 0,
        });
      });
    }

    // 92. 双子座（21090 光影双生）：被攻击一次后减伤层数清零
    if (hurt > 0 && t.talent === 21090) {
      t.geminiMitStacks = 0;
    }

    // 98. 史蒂芬妮（21850 智慧磨炼）：受击时根据敌方誓灵属性提升对应2级能力等级
    if (t.talent === 21850 && hurt > 0) {
      const natToProp = { 1: 104, 2: 101, 3: 105, 4: 103, 5: 102, 6: 111 };
      const prop = natToProp[actor.nature];
      if (prop) {
        t.statLevels = t.statLevels || {};
        t.statLevels[prop] = Math.min(6, (t.statLevels[prop] || 0) + 2);
        const an = PROP_ATTR_NAMES[prop];
        if (an) t[an] = t.statLevels[prop];
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 21850,
          id: 21850,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, 2, t.statLevels[prop])],
          remove_round: 0,
        });
      }
    }

    // 100. 丑（22000 画地为牢）：位于左右的誓灵受击时随机1项防御+1
    if (hurt > 0) {
      const chouList = (allUnits || []).filter(x => x && x.hp > 0 && x.side === t.side && x.talent === 22000);
      chouList.forEach(chou => {
        const adjacent = (allUnits || []).filter(a => a && a.hp > 0 && a.side === t.side &&
          a.id !== chou.id && Math.abs((a.pos && a.pos[0] || 0) - (chou.pos && chou.pos[0] || 0)) <= 1);
        if (adjacent.includes(t)) {
          const p = Math.random() < 0.5 ? 103 : 104;
          gainStat(t, p, 1, { effects: wakeEffects, srcId: 22000, atkId: actor.id, srcServantId: chou.id, phase });
        }
      });
    }

    // 102. 辰（22030 真炎庇佑）：受到物理攻击时攻击方被烧伤
    if (hurt > 0 && cfg.type === 1 && (allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.talent === 22030) && actor.hp > 0) {
      actor.buffs = actor.buffs || {};
      actor.buffs[BUFF_IDS.BURN] = { level: 1, duration: 3 };
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 22030,
        id: 22030,
        effect_phase: phase,
        change_type: 300019,
        change_value: [encodeBuffVal(BUFF_IDS.BURN, 1)],
        remove_round: 3,
      });
    }

    // 104. 亥（22100 滂沱）：护盾被消耗时恢复被消耗护盾值25%生命（雨天50%）
    if (hurt > 0 && t.shieldConsumedThisHit > 0) {
      const rain = ((battleState && battleState.weather && battleState.weather.start_weather) === WEATHER_IDS.RAIN);
      const ratio = rain ? 0.50 : 0.25;
      const heal = Math.max(1, Math.round(t.shieldConsumedThisHit * ratio));
      const after = Math.min(t.maxHp, t.hp + heal);
      t.hp = after;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 22100,
        id: 22100,
        effect_phase: phase,
        change_type: 200000,
        change_value: [heal],
        remove_round: 0,
      });
      t.shieldConsumedThisHit = 0;
    }

    // =========================================================================
    // SR 阶段六（Phase 6）受创后终局反制
    // =========================================================================
    // 109. 乌波萨斯拉（21880 无源之源）：受到物理攻击时吸收敌方当前20%生命值
    if (t.talent === 21880 && hurt > 0 && cfg.type === 1 && actor.hp > 0) {
      const drain = Math.max(1, Math.round(actor.hp * 0.20));
      const healed = Math.min(drain, t.maxHp - t.hp);
      actor.hp = Math.max(1, actor.hp - drain);
      if (healed > 0) t.hp += healed;
      // 两条 effect 各有自己的目标：抽血给攻击者(-)，回血给持有者(+)。**不能合成一条多值**
      //（客户端按目标下标取值，第二条会被丢弃；而拆分器会把回血错挂到攻击者身上）。
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 21880,
        id: 21880,
        effect_phase: phase,
        change_type: 200000,
        change_value: [-drain],
        remove_round: 0,
      });
      if (healed > 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 21880,
          id: 21880,
          effect_phase: phase,
          change_type: 200000,
          change_value: [healed],
          remove_round: 0,
        });
      }
    }

    // 114. 增长天（22230 青云剑锋）：敌方每受到增长天一次伤害，被攻击时攻击者临时暴击+1
    if (actor.talent === 22230 && hurt > 0) {
      t.virudhakaHitStacks = (t.virudhakaHitStacks || 0) + 1;
    }

    // 122. 阿修罗（22720 阿修罗道）：每失去1%生命获得2战意（上限200）
    if (t.talent === 22720 && hurt > 0) {
      const pct = Math.max(1, Math.round((hurt / t.maxHp) * 100));
      t.asuraWill = Math.min(200, (t.asuraWill || 0) + (pct * 2));
    }
    // 阿修罗：受到伤害时消耗50战意恢复15%生命
    if (t.talent === 22720 && hurt > 0 && (t.asuraWill || 0) >= 50) {
      t.asuraWill -= 50;
      const heal = Math.max(1, Math.round(t.maxHp * 0.15));
      const after = Math.min(t.maxHp, t.hp + heal);
      t.hp = after;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 22720,
        id: 22720,
        effect_phase: phase,
        change_type: 200000,
        change_value: [heal],
        remove_round: 0,
      });
    }

    // 125. 凯布利（22850 圣甲虫之秘）：失去生命后己方全体下次攻击提升失血百分比75%增伤与吸血
    if (t.talent === 22850 && hurt > 0) {
      const lostPct = (hurt / t.maxHp) * 100;
      const bonus = lostPct * 0.75 / 100;
      (allUnits || []).forEach(a => {
        if (a && a.hp > 0 && a.side === t.side) {
          a.khepriNextBonus = Math.max(a.khepriNextBonus || 0, bonus);
        }
      });
    }

    // 128. 凡赛堤（22990 审判）：对我方角色造成伤害时敌方被添加法典
    // （三百一十三：原 change_type:0 空横幅 ⇒ 客户端只见横幅不见图标，且空值 tar 被 sanitize 清掉；
    //   原位升级为 ADD_BUFF——横幅条件与 change_type 无关，「凡赛堤的审判」横幅保留，图标由
    //   change_value=encodeBuffVal(22990,1) 驱动）
    const forsetiUnits = (allUnits || []).filter(x => x && x.hp > 0 && x.side === t.side && x.talent === 22990);
    if (forsetiUnits.length > 0 && hurt > 0 && actor.hp > 0 && !actor.forsetiCodexActive && !(actor.forsetiCodexCooldown > 0)) {
      actor.forsetiCodexActive = true;
      actor.forsetiCodexRounds = 2;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
        src_servant_id: forsetiUnits[0].id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 22990,
        id: 22990,
        effect_phase: phase,
        change_type: 300019,
        change_value: [encodeBuffVal(22990, 1)],
        remove_round: 2,
      });
    }

    // 112. 安格斯（22200 未逐之爱）：攻击后偷取敌方一项最高正向能力等级
    if (actor.talent === 22200 && hurt > 0 && t.statLevels) {
      const posKeys = Object.keys(t.statLevels).filter(k => (t.statLevels[k] || 0) > 0);
      if (posKeys.length > 0) {
        const bestKey = posKeys.sort((a, b) => t.statLevels[b] - t.statLevels[a])[0];
        const p = Number(bestKey);
        t.statLevels[p] = Math.max(-6, t.statLevels[p] - 1);
        actor.statLevels = actor.statLevels || {};
        actor.statLevels[p] = Math.min(6, (actor.statLevels[p] || 0) + 1);
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 22200,
          id: 22200,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(p, -1, t.statLevels[p])],
          remove_round: 0,
        });
      }
    }

    // 121. 奥斯卡（22660 飞舞的扫帚）：造成伤害时随机选择目标一项不为0的能力等级处理
    if (actor.talent === 22660 && hurt > 0 && t.statLevels) {
      const nonZero = Object.keys(t.statLevels).filter(k => (t.statLevels[k] || 0) !== 0);
      if (nonZero.length > 0) {
        const pk = nonZero[Math.floor(Math.random() * nonZero.length)];
        const p = Number(pk);
        const lv = t.statLevels[p] || 0;
        actor.statLevels = actor.statLevels || {};
        if (lv < 0) {
          // 负向：清除且自身提升相同类型和级数
          actor.statLevels[p] = Math.min(6, (actor.statLevels[p] || 0) + (-lv));
          t.statLevels[p] = 0;
        } else {
          // 正向：下降3级，最多降至0
          t.statLevels[p] = Math.max(0, lv - 3);
        }
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 22660,
          id: 22660,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(p, t.statLevels[p] - lv, t.statLevels[p])],
          remove_round: 0,
        });
      }
    }

    // 123. 迦楼罗（22730 琉璃心）：攻击中毒目标附加自身速度25%数值的伤害
    if (actor.talent === 22730 && hurt > 0 && t.buffs && t.buffs[BUFF_IDS.POISON]) {
      const spd = (actor.attrs && actor.attrs.speed) || 100;
      const extra = Math.max(1, Math.round(spd * 0.25));
      t.hp = Math.max(1, t.hp - extra);
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 22730,
        id: 22730,
        effect_phase: phase,
        change_type: 200000,
        change_value: [-extra],
        remove_round: 0,
      });
    }

    // 129. 加雷斯（23030 四色传说）：成功使用攻击技能造成伤害后随机夺取1项能力等级
    // 原实现只 push 了「目标 -1」，自己那半（+1）没有任何事件 —— 玩家只看得到敌人掉等级。
    if (actor.talent === 23030 && hurt > 0 && t.statLevels && !actor.quartetStolen) {
      actor.quartetStolen = true;
      const props = [101, 102, 103, 104, 105];
      const p = props[Math.floor(Math.random() * props.length)];
      t.statLevels[p] = Math.max(-6, (t.statLevels[p] || 0) - 1);
      actor.statLevels = actor.statLevels || {};
      const gOld = Number(actor.statLevels[p]) || 0;
      const gNew = Math.min(6, gOld + 1);
      const gDelta = gNew - gOld;
      actor.statLevels[p] = gNew;
      const gName = PROP_ATTR_NAMES[p];
      if (gName) actor[gName] = gNew;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 23030,
        id: 23030,
        effect_phase: phase,
        change_type: 100000,
        change_value: [encodeAttrVal(p, -1, t.statLevels[p])],
        remove_round: 0,
      });
      if (gDelta > 0) wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 23030,
        id: PROP_FEATURE_IDS[p] || 20001,
        effect_phase: phase,
        change_type: 100000,
        change_value: [encodeAttrVal(p, gDelta, gNew)],
        remove_round: 0,
      });
    }

    // 119. 伊斯（22580 电浆枪）：每次成功造成伤害累计1点电浆能量（上限5）
    if (actor.talent === 22580 && hurt > 0) {
      actor.plasmaEnergy = Math.min(5, (actor.plasmaEnergy || 0) + 1);
    }
    // 126. 鹿蜀（22940 音之回踏）：声音技能对目标造成伤害时，十字相邻敌方下次受伤+20%
    if (actor.talent === 22940 && hurt > 0) {
      t.lushuCrossVuln = 0.20;
    }

    // 犹格索托斯受击充能（走统一出口：攒满 100 时同样触发 +2 魔攻 +1 其他，见 chargeVoid）
    if (t.talent === 21910 && hurt > 0) {
      chargeVoid(t, 10, wakeEffects, phase, actor.id, rnd);
    }

    // 33. 瓦利（22140 复仇者）：队友被击败时自身全能力+2且无视击杀者正向防御与闪避
    // 36. 阿特拉斯（22380 苦痛擎天者）：被击倒时对敌方造成自身最大生命值的伤害，由敌方均摊
    if (t.hp <= 0 || (t.hp - hurt <= 0 && hurt >= t.hp)) {
      // 天之甘露（10412）：击败敌方单位时获得1层"血铠"（CfgSkillDetail fightDesc，与天赋 23140 共用计数）
      // 三百一十三：CfgBuff[23140] 官方层数表就是 0~3 ⇒ 击杀叠层按 3 封顶 + 300019 同步层数
      if (skillRule && skillRule.onKillBloodArmor && t.side !== actor.side) {
        actor.bloodArmorLayers = Math.min(3, (actor.bloodArmorLayers || 0) + skillRule.onKillBloodArmor);
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
          src_type: 1, src_id: 23140, id: 23140, effect_phase: phase,
          change_type: 300019, change_value: [encodeBuffVal(23140, actor.bloodArmorLayers)], remove_round: 0,
        });
      }
      (allUnits || []).forEach(ally => {
        if (ally && ally.hp > 0 && ally.side === t.side) {
            if (ally.talent === 22140) {
              [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
                gainStat(ally, p, 2, { effects: wakeEffects, srcId: 22140, atkId: ally.id, srcServantId: ally.id, phase });
              });
              ally.valiRevengeAgainst = actor.id;
            }
        }
      });
      // 127. 玉兔（22950 长生不老药）：持有长生药的队友生命降为0时恢复35%生命且全能力+1
      // 注意：本 forEach 尾部统一 `t.hp = after` 写回终值——这里不能直接改 t.hp（会被覆盖），
      // 用 revivedHp 暂存复活后的生命，尾部写回时生效（官方伤害公式下致命伤 after=0，
      // 直接写 t.hp 会被 4046 覆盖回 0，2026-10-12 phase6 #127 实证）
      if (t.jadeRabbitElixir && !t.jadeRabbitUsed) {
        const hasJadeRabbit = (allUnits || []).some(x => x && x.hp > 0 && x.side === t.side && x.talent === 22950);
        if (hasJadeRabbit) {
          t.jadeRabbitUsed = true;
          // 注意 jadeRabbitElixir 保持 true（原语义：一场一颗，jadeRabbitUsed 防再耗；
          // 置 false 会让上方授予循环下回合重新授予+重复推图标）
          revivedHp = Math.max(1, Math.round(t.maxHp * 0.35));
            [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
              gainStat(t, p, 1, { effects: wakeEffects, srcId: 22950, atkId: t.id, srcServantId: t.id, phase });
            });
          wakeEffects.push({
            trigger_count: 0,
            atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
            src_servant_id: t.id,
            tar_servant_ids: [t.id],
            src_type: 1,
            src_id: 22950,
            id: 22950,
            effect_phase: phase,
            change_type: 200000,
            change_value: [revivedHp],
            remove_round: 0,
          });
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
            src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
            change_type: 300020, change_value: [22950], remove_round: 0,
          });
        }
      }

      // 113. 莪相（22210 史诗书记）：己方击倒敌方时较高攻击与较低防御各+1级
      (allUnits || []).forEach(oss => {
        if (oss && oss.hp > 0 && oss.talent === 22210 && oss.side === actor.side) {
          const highProp = (oss.attrs && oss.attrs.phy_atk >= oss.attrs.mag_atk) ? 101 : 102;
          const lowProp = (oss.attrs && oss.attrs.phy_def <= oss.attrs.mag_def) ? 103 : 104;
          gainStat(oss, highProp, 1, { effects: wakeEffects, srcId: 22210, atkId: actor.id, srcServantId: oss.id, phase });
          gainStat(oss, lowProp, 1, { effects: wakeEffects, srcId: 22210, atkId: actor.id, srcServantId: oss.id, phase });
        }
      });

      // 123. 迦楼罗（22730 琉璃心）：自身被击败时敌方全体中毒
      // （三百一十三：毒 buff 此前只写内部 map 零下发——补 300019，展示 id 用官方中毒生效 90801）
      if (t.talent === 22730) {
        (allUnits || []).forEach(f => {
          if (f && f.hp > 0 && f.side !== t.side) {
            f.buffs = f.buffs || {};
            f.buffs[BUFF_IDS.POISON] = { level: 1, duration: 3 };
            wakeEffects.push({
              trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [f.id],
              src_type: 3, src_id: 0, id: BUFF_FEATURE_IDS[BUFF_IDS.POISON].apply, effect_phase: phase,
              change_type: 300019, change_value: [encodeBuffVal(BUFF_IDS.POISON, 1)], remove_round: 3,
            });
          }
        });
      }

      // 82. 塔纳托斯（22510 冥界壁障）：场上有敌方被击倒时获得20%护盾
      (allUnits || []).forEach(th => {
        if (th && th.hp > 0 && th.talent === 22510 && th.side !== t.side) {
          const shieldVal = Math.max(1, Math.round(th.maxHp * 0.20));
          th.shield = (Number(th.shield) || 0) + shieldVal;
          wakeEffects.push({
            trigger_count: 0,
            atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 th.id）
            src_servant_id: th.id,
            tar_servant_ids: [th.id],
            src_type: 1,
            src_id: 22510,
            id: 22510,
            effect_phase: phase,
            // 2026-10-27：护盾必须走 200001（200000 正值客户端当回血播、盾不可见）
            change_type: 200001,
            change_value: [shieldVal],
            remove_round: 0,
          });
        }
      });
      // 毒龙之体（22250 那伽）击倒段：自身被敌方技能击倒时，直接对该敌方造成自身最大生命 30% 的伤害
      if (t.talent === 22250 && actor.hp > 0) {
        const back = Math.max(1, Math.round((t.maxHp || (t.attrs && t.attrs.hp) || 1) * 0.30));
        actor.hp = Math.max(0, actor.hp - back);
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [actor.id],
          src_type: 1, src_id: 22250, id: 22250, effect_phase: phase,
          change_type: 200000, change_value: [-back], remove_round: 0,
        });
      }
      // —— 批次C 击倒联动族（二百五十二）——
      // 死灵凭依（20050 巫妖）：在场时，每有一名誓灵被攻击击倒，魔攻提升1级（不分阵营）
      (allUnits || []).forEach(l => {
        if (l && l.hp > 0 && l.talent === 20050) {
          gainStat(l, 102, 1, { effects: wakeEffects, srcId: 20050, atkId: actor.id, srcServantId: l.id, phase });
        }
      });
      // 生命掠夺（20100 杜拉罕）：敌方被击倒时，自身回复最大HP的25%（击倒的是 20100 持有者的敌方）
      (allUnits || []).forEach(l => {
        if (l && l.hp > 0 && l.talent === 20100 && l.side !== t.side) {
          const heal = Math.max(1, Math.floor((l.maxHp || (l.attrs && l.attrs.hp) || l.hp) * 0.25));
          l.hp = Math.min(l.maxHp, l.hp + heal);
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: l.id, tar_servant_ids: [l.id],
            src_type: 1, src_id: 20100, id: 20100, effect_phase: phase,
            change_type: 200000, change_value: [heal], remove_round: 0,
          });
        }
      });
      // 不朽之灵（20990 巴）：场上其他誓灵被击倒后，将其所有正向能力变化转移至自身
      (allUnits || []).forEach(l => {
        if (l && l.hp > 0 && l.talent === 20990 && l.id !== t.id) {
          const props = [101, 102, 103, 104, 105, 111, 113, 115];
          let transferred = false;
          props.forEach(pp => {
            const lv = (t.statLevels && t.statLevels[pp]) || 0;
            if (lv > 0) {
              t.statLevels[pp] = 0;
              const an = PROP_ATTR_NAMES[pp];
              if (an) t[an] = 0;
              gainStat(l, pp, lv, { effects: wakeEffects, srcId: 20990, atkId: actor.id, srcServantId: l.id, phase });
              transferred = true;
            }
          });
          if (transferred) {
            wakeEffects.push({
              trigger_count: 0, atk_servant_id: actor.id, src_servant_id: l.id, tar_servant_ids: [l.id],
              src_type: 1, src_id: 20990, id: 20990, effect_phase: phase,
              change_type: 0, change_value: [], remove_round: 0,
            });
          }
        }
      });
      // 生命之魂（21200 卡）：天赋持有者被击倒后，所有正向能力变化加到随机1名己方誓灵上
      if (t.talent === 21200) {
        const heirs = (allUnits || []).filter(a => a && a.hp > 0 && a.side === t.side && a.id !== t.id);
        if (heirs.length > 0) {
          const heir = heirs[Math.floor(Math.random() * heirs.length)];
          const props = [101, 102, 103, 104, 105, 111, 113, 115];
          props.forEach(pp => {
            const lv = (t.statLevels && t.statLevels[pp]) || 0;
            if (lv > 0) {
              t.statLevels[pp] = 0;
              const an = PROP_ATTR_NAMES[pp];
              if (an) t[an] = 0;
              gainStat(heir, pp, lv, { effects: wakeEffects, srcId: 21200, atkId: t.id, srcServantId: heir.id, phase });
            }
          });
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [heir.id],
            src_type: 1, src_id: 21200, id: 21200, effect_phase: phase,
            change_type: 0, change_value: [], remove_round: 0,
          });
        }
      }
      // 35. 墨诺提俄斯（22370 暴怒抗争者）：击倒敌方誓灵时使剩余敌方进入3回合激怒状态
      if (actor.talent === 22370) {
        (allUnits || []).forEach(f => {
          if (f && f.hp > 0 && f.side !== actor.side) {
            f.enragedRounds = 3;
          }
        });
      }
      if (t.talent === 22380) {
        const atlasFoes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== t.side);
        if (atlasFoes.length > 0) {
          const splash = Math.max(1, Math.floor(t.maxHp / atlasFoes.length));
          atlasFoes.forEach(f => {
            const beforeHp = f.hp;
            f.hp = Math.max(0, f.hp - splash); // 天赋伤害可致死（不再保底 1 HP）
            const real = beforeHp - f.hp;
            if (real > 0) wakeEffects.push({
              // 已知问题（暂回退）：阿特拉斯阵亡后客户端会立刻把他移出场景，若 src 用阿特拉斯，
              // 223801（act=20661）演出会被 FeatureLoop 丢弃 → 玩家看不到分摊演出。
              // 临时方案：挂到仍存活的受击敌方 f 上，保证演出/数字；副作用是天赋横幅头像显示为右侧敌方。
              // 正确方向：死亡演出延后一包（阵亡单位保留在客户端场景）再下发 223801。
              trigger_count: 0,
              atk_servant_id: f.id,
              src_servant_id: f.id,
              tar_servant_ids: [f.id],
              src_type: 1,
              src_id: 22380,
              id: 223801,
              effect_phase: phase,
              change_type: 200000,
              change_value: [-real],
              remove_round: 0,
            });
          });
        }
      }
    }

    // 76. 赫拉克勒斯（21550 十二功绩）：自身使用技能或受到技能攻击后增加1次功绩
    if (hurt > 0 && t && t.talent === 21550) {
      t.heraclesFeats = Math.min(12, (t.heraclesFeats || 0) + 1);
        if (t.heraclesFeats >= 12) {
          [101, 105].forEach(p => {
            gainStat(t, p, 2, { effects: wakeEffects, srcId: 21550, atkId: t.id, srcServantId: t.id, phase });
          });
        }
    }

    // 69. 兀尔德（20840 命运·过去）：记录本次所受伤害总额
    if (hurt > 0 && t && t.hp > 0 && t.talent === 20840) {
      t.urdLastTakenDamage = (t.urdLastTakenDamage || 0) + hurt;
    }

    // 75. 嫦娥（21300 长生之愿）：统计本回合受击次数（每次递减25%伤害）
    if (hurt > 0 && t && t.hp > 0) {
      t.hitsThisRound = (t.hitsThisRound || 0) + 1;
    }
    // 69. 兀尔德（20840 命运·过去）：统计受击次数供下回合增伤
    if (hurt > 0 && t && t.hp > 0 && t.talent === 20840) {
      t.urdHitsLastRound = (t.urdHitsLastRound || 0) + 1;
    }

    // 标记本回合已造成伤害（供贝尔芬格 21760 怠之长眠者 判定）
    if (hurt > 0 && actor && actor.hp > 0) {
      actor.dealtDamageThisRound = true;
      // 53. 酒吞童子（21400 大江山之鬼）：造成技能伤害后进入暴怒状态
      if (actor.talent === 21400 && cfg.power > 0) actor.shutenRage = true;
    }

    // 10253 王座的守护：本回合每受到一次攻击，较高一项攻击 +1
    if ((hurt > 0 || shieldHurt > 0) && (t.kingsGuardRounds || 0) > 0) {
      // 敌方行动中产生的属性事件客户端不显示；记录受击次数，回合末统一结算（与 10391 同口径）
      t.kingsGuardHits = (Number(t.kingsGuardHits) || 0) + 1;
    }
    // 记录目标受击者历史（供夏色祭友情的力量判定）
    if (hurt > 0) {
      t.hitThisRound = true;
      t.hitByServants = t.hitByServants || [];
      t.hitByServants.push({
        id: actor.id,
        type: actor.type,
        isHolo: isHoloServant(actor.type),
      });
      // 回溯之剑（10209）配套：按来源记录本回合受到的技能伤害（回合末快照为 hitByFromLastRound）
      t.hitFromThisRound = t.hitFromThisRound || {};
      t.hitFromThisRound[actor.id] = true;
      // 涌动之拳（3021004 专属）：目标 3 回合内对那伽造成过伤害 → actor 记标记
      if (Number(t.type) === 3021004 && battleState) actor.hitNagaRoundUntil = battleState.round + 3;
      // P3-C 首伤追踪（光速之拳 10154 专属：本回合第一名造成技能伤害者）
      if (battleState && battleState.firstDmgRound !== battleState.round) {
        battleState.firstDmgRound = battleState.round;
        battleState.firstDmgActor = actor.id;
      }
      // P3-C 须佐的箭羽：被标记者每次受击 → 大国主物攻速度+1
      if ((t.susaMarkRounds || 0) > 0) {
        const owner = (allUnits || []).find(u => u && u.id === t.susaMarkOwner && u.hp > 0);
        if (owner) {
          gainStat(owner, 101, 1, { effects: wakeEffects, srcId: 10348, srcType: 3, atkId: owner.id, srcServantId: owner.id, phase });
          gainStat(owner, 105, 1, { effects: wakeEffects, srcId: 10348, srcType: 3, atkId: owner.id, srcServantId: owner.id, phase });
        }
      }
      // P3 抵抗姿态：受击按关系提升能力（10392 非同属性抵抗→较高攻+1；同属性被克制→防御+1）
      if ((t.stanceRounds || 0) > 0 && t.stanceKind === 'resist_non_same') {
        if (rel === 2) gainStat(t, (t.attrs && t.attrs.phy_atk >= t.attrs.mag_atk) ? 101 : 102, 1, { effects: wakeEffects, srcId: 10392, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
        if (rel === 1) gainStat(t, Math.random() < 0.5 ? 103 : 104, 1, { effects: wakeEffects, srcId: 10392, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
      }
      if ((t.stanceRounds || 0) > 0 && t.stanceKind === 'resist_same_enemy' && rel === 2) {
        gainStat(t, 105, 1, { effects: wakeEffects, srcId: 10396, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
        gainStat(t, Math.random() < 0.5 ? 101 : 102, 1, { effects: wakeEffects, srcId: 10396, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
      }
      // P3 逆光贯雷（10300）：受克制伤害后 +2 攻 / +2 魔攻（3 回合）
      if (rel === 2) {
        if ((t.fragarachRounds || 0) > 0) gainStat(t, 101, 2, { effects: wakeEffects, srcId: 10300, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
        if ((t.brionacRounds || 0) > 0) gainStat(t, 102, 2, { effects: wakeEffects, srcId: 10300, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
      }
      // P4 甜蜜梦境基础：下一次非光伤 → 双防-1（一次性）
      if (t.sweetDreamNext && cfg.nature !== 5) {
        t.sweetDreamNext = false;
        gainStat(t, 103, -1, { effects: wakeEffects, srcId: 10407, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
        gainStat(t, 104, -1, { effects: wakeEffects, srcId: 10407, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
      }
      // P3-C 甜蜜梦境：受非光伤双防-1（每击）
      if ((t.sweetDreamRounds || 0) > 0 && cfg.nature !== 5) {
        gainStat(t, 103, -1, { effects: wakeEffects, srcId: 10407, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
        gainStat(t, 104, -1, { effects: wakeEffects, srcId: 10407, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
      }
      // P3-C 暗夜主宰：受击吸取敌方 20%（按伤害口径）
      if ((t.nightLordRounds || 0) > 0 && actor.hp > 0) {
        const drain = Math.max(1, Math.round(hurt * 0.20));
        const after = Math.min(t.maxHp, t.hp + drain);
        if (after > t.hp) {
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
            src_type: 3, src_id: 10336, id: 60120, effect_phase: phase,
            change_type: 200000, change_value: [after - t.hp], remove_round: 0,
          });
          t.hp = after;
        }
      }
      // P3-C 仇恨吸引（3021004 版）：受击回 10% + 随机防御+1
      if ((t.grudgeAbsorbRounds || 0) > 0) {
        const maxH = t.maxHp || 1;
        const heal = Math.min(Math.max(1, Math.round(maxH * 0.10)), maxH - t.hp);
        if (heal > 0) {
          t.hp += heal;
          // 2026-10-27：回血补 200000 正值（原本无任何通道；落账并回后终值已含治疗，
          // 客户端 final_hp + 本条 delta 与服务端一致）
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
            src_type: 3, src_id: 10006, id: 60120, effect_phase: phase,
            change_type: 200000, change_value: [heal], remove_round: 0,
          });
        }
        gainStat(t, Math.random() < 0.5 ? 103 : 104, 1, { effects: wakeEffects, srcId: 10006, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
      }
      // P3-C 神圣祝福：受伤 20% 随机防御+1
      if (t.holyBless && Math.random() < 0.20) {
        gainStat(t, Math.random() < 0.5 ? 103 : 104, 1, { effects: wakeEffects, srcId: 10149, srcType: 3, atkId: t.id, srcServantId: t.id, phase });
      }
      // P3-C 法力屏障（10002 专属改写·1345012）：受魔法伤害计数，每两次全队较高攻击+1
      if ((t.magicBarrierRounds || 0) > 0 && cfg.type === 2) {
        t.magicHitsTaken = (t.magicHitsTaken || 0) + 1;
        if (t.magicHitsTaken % 2 === 0) {
          (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side).forEach(a => {
            gainStat(a, (a.attrs && a.attrs.phy_atk >= a.attrs.mag_atk) ? 101 : 102, 1, { effects: wakeEffects, srcId: 10002, atkId: t.id, srcServantId: a.id, phase });
          });
        }
      }
      // P3-C 断罪炎王剑：红桃印记层数在伤害乘区消费（施加在专属施放侧）
      // P3-C 光辉之剑：被标记者受单体光系直接伤害 → 其余敌方 150%
      if ((t.lightSwordRounds || 0) > 0 && cfg.nature === 5 && hurt > 0) {
        const lsPct = Number(t.lightSwordPct) > 0 ? Number(t.lightSwordPct) : 1.5;
        const others = (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side && u.id !== t.id);
        others.forEach(o => {
          const dmg = Math.max(1, Math.round(hurt * lsPct));
          o.hp = Math.max(0, o.hp - dmg);
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [o.id],
            src_type: 3, src_id: 10395, id: 60120, effect_phase: phase,
            change_type: 200000, change_value: [-dmg], remove_round: 0,
          });
        });
      }
    }

    // 睡眠受击唤醒机制：受击且造成实质伤害（hurt > 0）时立即解除睡眠
    if (hurt > 0 && t.buffs && t.buffs[BUFF_IDS.SLEEP]) {
      delete t.buffs[BUFF_IDS.SLEEP];
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: t.id,
        tar_servant_ids: [t.id],
        src_type: 1, // FIGHT_EFF_FEATURE
        src_id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].remove,
        id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].remove, // 90702
        effect_phase: phase,
        change_type: 300020, // FIGHT_EFF_CHANGE_TYPE_REDUCE_BUFF
        change_value: [BUFF_IDS.SLEEP],
        remove_round: 0,
      });
    }

    // 邪眼（10344）：暴击时 50% 几率施加睡眠（10353/10375 的 WIKI 异常免疫在此也生效）
    if (crit && skillRule && skillRule.sleepOnCrit && rnd() * 100 < skillRule.sleepOnCrit) {
      if (!abnormalBlocked(t, BUFF_IDS.SLEEP)) {
      t.buffs = t.buffs || {};
      t.buffs[BUFF_IDS.SLEEP] = { level: 1, duration: 3 };
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].apply,
        id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].apply,
        effect_phase: phase,
        change_type: 300019, // FIGHT_EFF_CHANGE_TYPE_ADD_BUFF（三百·续修正：原写 300010 不是客户端常量 → 状态施加在客户端完全失效）
        change_value: [BUFF_IDS.SLEEP],
        remove_round: 3,
      });
      }
    }
    // 技能 10208（勇者的激奏）：若使用者攻击时带有护盾值，造成伤害后 50% 几率使目标物防、速度下降 1 级
    if (cfg.id === 10208 && hadShieldBeforeAtk && (hurt > 0 || shieldHurt > 0) && rnd() < 0.50) {
      [103, 105].forEach(prop => {
        t.statLevels = t.statLevels || {};
        const oldLv = t.statLevels[prop] || 0;
        const newLv = Math.max(-6, Math.min(6, oldLv - 1));
        const realDelta = newLv - oldLv;
        t.statLevels[prop] = newLv;
        const attrName = PROP_ATTR_NAMES[prop];
        if (attrName) t[attrName] = newLv;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 10208,
          id: 10208,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, realDelta)],
          remove_round: 0,
        });
      });
    }

    // 托尔（20630 破天轰雷）：风/光技能造成伤害时 20% 几率施加麻痹或畏惧
    if (actor.talent === 20630 && (cfg.nature === 3 || cfg.nature === 5) && (hurt > 0 || shieldHurt > 0) && rnd() < 0.20) {
      if (rnd() < 0.50) {
        t.buffs = t.buffs || {};
        t.buffs[BUFF_IDS.PARALYSIS] = { level: 1, duration: 3 };
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 20630,
          id: BUFF_FEATURE_IDS[BUFF_IDS.PARALYSIS].apply, // 90001
          effect_phase: phase,
          change_type: 300019,
          change_value: [encodeBuffVal(BUFF_IDS.PARALYSIS, 1)],
          remove_round: 3,
        });
      } else {
        applyFlinch(t, wakeEffects, phase, 20630, actor.id);
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 20630,
          id: 90501, // 畏惧
          effect_phase: phase,
          change_type: 0,
          change_value: [],
          remove_round: 0,
        });
      }
    }

    // 乌列尔（21730 神之光）：造成伤害后使目标下回合单体技能强制以自身为目标
    if (actor.talent === 21730 && (hurt > 0 || shieldHurt > 0) && t.hp > 0) {
      t.tauntedBy = actor.id;
      t.tauntRounds = 2;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [t.id],
        src_type: 1,
        src_id: 21730,
        id: 90601, // 嘲讽
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 2,
      });
    }

    // 阿尔忒弥斯（21540 辉光神狩）：生命低于60%时目标物防下降1级
    if (artemisDefDown && (hurt > 0 || shieldHurt > 0) && t.hp > 0) {
      t.statLevels = t.statLevels || {};
      const oldLv = t.statLevels[103] || 0;
      const newLv = Math.max(-6, Math.min(6, oldLv - 1));
      const realDelta = newLv - oldLv;
      t.statLevels[103] = newLv;
      t.phy_def_lv = newLv;
      if (realDelta !== 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 21540,
          id: PROP_FEATURE_IDS[103], // 20003
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(103, realDelta, newLv)],
          remove_round: 0,
        });
      }
    }

    // 五河琴里（21660 炎魔）：打火系物攻+1且回血10%；打非火物防-1且下次受火伤+25%
    if (actor.talent === 21660 && (hurt > 0 || shieldHurt > 0) && t.hp > 0) {
      if (t.nature === 2) {
        const atkDelta = gainStat(actor, 101, 1, { effects: wakeEffects, srcId: 21660, atkId: actor.id, srcServantId: actor.id, phase });
        const healAmt = Math.min(actor.maxHp - actor.hp, Math.round(actor.maxHp * 0.10));
        if (healAmt > 0) {
          actor.hp += healAmt;
          // 2026-10-27：回血补 30531 甘露通道（狼人 20870 同款，act=20015 回血动画）
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
            src_type: 1, src_id: 30531, id: 30531, effect_phase: phase,
            change_type: 200000, change_value: [healAmt], remove_round: 0,
          });
        }
        // 满级时不再宣称"+1"（写死 delta=1 会弹一条数字与结果不符的飘字）
        if (atkDelta > 0) wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 21660,
          id: 21660,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(101, atkDelta)],
          remove_round: 0,
        });
      } else {
        t.statLevels = t.statLevels || {};
        const oldDef = Number(t.statLevels[103]) || 0;
        const newDef = Math.max(-6, oldDef - 1);
        const defDelta = newDef - oldDef;
        t.statLevels[103] = newDef;
        t.phy_def_lv = newDef;
        t.kotoriFireVuln = 0.25;
        if (defDelta !== 0) wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 21660,
          id: 20003,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(103, defDelta)],
          remove_round: 0,
        });
      }
    }

    // 夜刀神十香（21680 公主）：若攻击物防被自身降低的目标，物攻+1且回复15%生命值
    if (actor.talent === 21680 && t.tohkaTargeted && (hurt > 0 || shieldHurt > 0) && t.hp > 0) {
      const atkDelta = gainStat(actor, 101, 1, { effects: wakeEffects, srcId: 21680, atkId: actor.id, srcServantId: actor.id, phase });
      // 官方：回复“该次伤害”的 15%（不是最大生命 15%）
      const dealtForHeal = Math.max(0, Math.round(hurt) + Math.round(shieldHurt || 0));
      const healAmt = Math.min(actor.maxHp - actor.hp, Math.round(dealtForHeal * 0.15));
      if (healAmt > 0) {
        actor.hp += healAmt;
        // 2026-10-27：回血补 30531 甘露通道（狼人 20870 同款）
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
          src_type: 1, src_id: 30531, id: 30531, effect_phase: phase,
          change_type: 200000, change_value: [healAmt], remove_round: 0,
        });
      }
      if (atkDelta > 0) wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 21680,
        id: 21680,
        effect_phase: phase,
        change_type: 100000,
        change_value: [encodeAttrVal(101, atkDelta)],
        remove_round: 0,
      });
    }

    // 湊阿库娅（21960 无敌的剑圣）：使用物理技能攻击时扣除自身15%最大生命值并使己方全体魔攻提升1级
    // ⚠️ 本段在 targets.forEach 内：一次技能命中 N 个目标就会进来 N 次。
    //    "扣血 + 全队魔攻 +1" 的语义是**每次技能一次**，必须用本次行动标记拦重复
    //    （2026-10-19 真机实测：打 2 个目标扣了两次 -9，全队魔攻却只按最后一次算）。
    // ⚠️ 魔攻提升原先只改服务端 statLevels、**不发 change_type=100000 事件**，
    //    客户端既没有等级图标变化也没有飘字 → 玩家反馈"光扣血不加属性"。
    //    数值其实在服务端生效（伤害按 attrLvMul(statLevels[102]) 计算），缺的只是表现层事件。
    if (actor.talent === 21960 && cfg.type === 1 && !actor.aquaSwordFired
        && (hurt > 0 || shieldHurt > 0) && actor.hp > 0) {
      actor.aquaSwordFired = true;
      const selfCost = Math.max(1, Math.round(actor.maxHp * 0.15));
      actor.hp = Math.max(1, actor.hp - selfCost);
      const livingAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
      livingAllies.forEach(ally => {
        gainStat(ally, 102, 1, { effects: wakeEffects, srcId: 21960, atkId: actor.id, srcServantId: ally.id, phase });
      });
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 21960,
        id: 21960,
        effect_phase: phase,
        change_type: 200000,
        change_value: [-selfCost],
        remove_round: 0,
      });
    }

    // 百鬼绫目（21970 久远之灵）：暴击时回复自身10%生命值
    if (actor.talent === 21970 && crit) {
      const healAmt = Math.min(actor.maxHp - actor.hp, Math.round(actor.maxHp * 0.10));
      if (healAmt > 0) {
        actor.hp += healAmt;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 21970,
          id: 21970,
          effect_phase: phase,
          change_type: 200000,
          change_value: [healAmt],
          remove_round: 0,
        });
      }
    }

    // 紫咲诗音（21980 福运之灵）：受到暴击时随机提升3项属性1级
    if (t.talent === 21980 && crit && t.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const shuffled = props.slice().sort(() => rnd() - 0.5);
      const picked = shuffled.slice(0, 3);
      const changes = [];
      picked.forEach(p => {
        t.statLevels = t.statLevels || {};
        const oldLv = t.statLevels[p] || 0;
        const newLv = Math.min(6, oldLv + 1);
        t.statLevels[p] = newLv;
        const an = PROP_ATTR_NAMES[p];
        if (an) t[an] = newLv;
        if (newLv > oldLv) changes.push(encodeAttrVal(p, 1, newLv));
      });
      if (changes.length > 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 21980,
          id: 21980,
          effect_phase: phase,
          change_type: 100000,
          change_value: changes,
          remove_round: 0,
        });
      }
    }

    // 白（21820 完全解析）：当自身处于护盾状态时受到攻击，攻击者随机一项攻击下降一级
    if (t.talent === 21820 && (t.shield > 0 || shieldHurt > 0) && actor && actor.hp > 0) {
      const prop = rnd() < 0.5 ? 101 : 102;
      actor.statLevels = actor.statLevels || {};
      const oldLv = actor.statLevels[prop] || 0;
      const newLv = Math.max(-6, Math.min(6, oldLv - 1));
      const delta = newLv - oldLv;
      actor.statLevels[prop] = newLv;
      const an = PROP_ATTR_NAMES[prop];
      if (an) actor[an] = newLv;
      if (delta !== 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
          src_servant_id: t.id,
          tar_servant_ids: [actor.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 21820,
          id: 21820,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, delta, newLv)],
          remove_round: 0,
        });
      }
    }

    // 加塔诺托亚（22450 无法直视者）：每回合敌方第一个攻击持有者的誓灵造成伤害后陷入石化状态，持续到下回合结束
    if (t.talent === 22450 && t.side !== actor.side && !t.gatanoHitThisRound && (hurt > 0 || shieldHurt > 0) && actor && actor.hp > 0) {
      t.gatanoHitThisRound = true;
      actor.petrified = true;
      actor.petrifyRounds = 2;
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id /* 修复：按 curEffData.atk_id 查桶 */,
        src_servant_id: t.id,
        tar_servant_ids: [actor.id],
        src_type: 1, // FIGHT_EFF_FEATURE
        src_id: 22450,
        id: 922401, // 石化生效
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 2,
      });
    }

    // 克苏鲁（21890 拉莱耶之主）：对敌方造成伤害时，若持有者某项能力等级高于敌方，则清除敌方该项能力等级
    if (actor.talent === 21890 && actor.side !== t.side && (hurt > 0 || shieldHurt > 0) && t && t.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const clearedChanges = [];
      props.forEach(p => {
        const actorLv = (actor.statLevels && actor.statLevels[p]) || 0;
        const targetLv = (t.statLevels && t.statLevels[p]) || 0;
        if (actorLv > targetLv && targetLv !== 0) {
          t.statLevels = t.statLevels || {};
          const delta = 0 - targetLv;
          t.statLevels[p] = 0;
          const an = PROP_ATTR_NAMES[p];
          if (an) t[an] = 0;
          clearedChanges.push(encodeAttrVal(p, delta, 0));
        }
      });
      if (clearedChanges.length > 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [t.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 21890,
          id: 21890,
          effect_phase: phase,
          change_type: 100000,
          change_value: clearedChanges,
          remove_round: 0,
        });
      }
    }

    // 玛查（21240 愤怒之魂）：连续攻击同一目标 combo 累加，否则重置
    if (actor.talent === 21240) {
      if (actor.machaTargetId === t.id) {
        actor.machaCombo = Math.min(4, (actor.machaCombo || 0) + 1);
      } else {
        actor.machaTargetId = t.id;
        actor.machaCombo = 1;
      }
    }

    // 茉莉安（20550 复仇之魂）：受到伤害使攻击者随机1项属性下降2级
    if (t.talent === 20550 && (hurt > 0 || shieldHurt > 0) && actor && actor.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(rnd() * props.length)];
      actor.statLevels = actor.statLevels || {};
      const oldLv = actor.statLevels[p] || 0;
      const newLv = Math.max(-6, oldLv - 2);
      const delta = newLv - oldLv;
      actor.statLevels[p] = newLv;
      const an = PROP_ATTR_NAMES[p];
      if (an) actor[an] = newLv;
      if (delta !== 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id, // 修复：客户端按 curEffData.atk_id 查桶，必须是攻击者（原 t.id）
          src_servant_id: t.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 20550,
          id: 20550,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(p, delta, newLv)],
          remove_round: 0,
        });
      }
    }

    // 雅典娜（21530 百战圣女）：受到伤害消耗1层圣盾，下回合伤害提高50%
    if (t.talent === 21530 && (hurt > 0 || shieldHurt > 0)) {
      if (t.athenaShields > 0) {
        t.athenaShields -= 1;
        t.athenaDmgBoostNext = (t.athenaDmgBoostNext || 0) + 0.50;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 21530,
          id: 21530,
          effect_phase: phase,
          change_type: 0,
          change_value: [t.athenaShields],
          remove_round: 0,
        });
      }
    }

    // 耶梦加得（21430 尘世巨蟒）：受到伤害使目标本回合获得巨蟒之毒
    if (t.talent === 21430 && (hurt > 0 || shieldHurt > 0)) {
      actor.midgardPoison = true;
    }

    // 波塞冬（20590 海渊的叛逆者）：受到攻击伤害时，随机1项能力提升2级
    if (t.talent === 20590 && (hurt > 0 || shieldHurt > 0) && t.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(rnd() * props.length)];
      t.statLevels = t.statLevels || {};
      const oldLv = t.statLevels[p] || 0;
      const newLv = Math.min(6, oldLv + 2);
      const delta = newLv - oldLv;
      t.statLevels[p] = newLv;
      const an = PROP_ATTR_NAMES[p];
      if (an) t[an] = newLv;
      if (delta > 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          src_id: 20590,
          id: 20590,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(p, delta, newLv)],
          remove_round: 0,
        });
      }
    }

    // 荷鲁斯（20950 抗争之眼）：造成伤害后目标回避与速度下降1级，且受到风属性伤害提升50%持续2回合
    if (actor.talent === 20950 && (hurt > 0 || shieldHurt > 0) && t.hp > 0) {
      t.windVulnerableRounds = 2;
      t.statLevels = t.statLevels || {};
      [115, 105].forEach(prop => {
        const oldLv = t.statLevels[prop] || 0;
        const newLv = Math.max(-6, oldLv - 1);
        const delta = newLv - oldLv;
        t.statLevels[prop] = newLv;
        const an = PROP_ATTR_NAMES[prop];
        if (an) t[an] = newLv;
        if (delta !== 0) {
          wakeEffects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [t.id],
            src_type: 1,
            src_id: 20950,
            id: 20950,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(prop, delta, newLv)],
            remove_round: 0,
          });
        }
      });
    }

    // 因陀罗（22260 忉利天之主）：己方攻击后消耗1层“天之赐”恢复5%生命并随机提升能力1级；因陀罗造成伤害添加2层“天之赐”（最高9层）
    const prevBlessingLayers = t.godBlessingLayers || 0;
    if (prevBlessingLayers > 0 && (hurt > 0 || shieldHurt > 0) && actor.side !== t.side) {
      t.godBlessingLayers = prevBlessingLayers - 1;
      const healAmt = Math.min(actor.maxHp - actor.hp, Math.floor(actor.maxHp * 0.05));
      if (healAmt > 0) {
        actor.hp += healAmt;
        // 2026-10-27：回血补 30531 甘露通道（狼人 20870 同款）
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
          src_type: 1, src_id: 30531, id: 30531, effect_phase: phase,
          change_type: 200000, change_value: [healAmt], remove_round: 0,
        });
      }
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor((typeof rng === 'function' ? rng() : Math.random()) * props.length)];
      gainStat(actor, p, 1, { effects: wakeEffects, srcId: 22260, atkId: actor.id, srcServantId: actor.id, phase });
    }
    if (actor.talent === 22260 && (hurt > 0 || shieldHurt > 0) && t.hp > 0) {
      t.godBlessingLayers = Math.min(9, (t.godBlessingLayers || 0) + 2);
    }

    // 大国主（22600 出云之魂）：每回合第一次受到伤害时，其余己方誓灵获得相同数值护盾
    // 2026-10-27：原先只改 ally.shield（处女座同型），补逐人 200001 让护盾条可见
    if (t.talent === 22600 && !t.firstHitShieldDone && (hurt > 0 || shieldHurt > 0)) {
      t.firstHitShieldDone = true;
      const shieldVal = (hurt + shieldHurt);
      (allUnits || []).forEach(ally => {
        if (ally && ally.hp > 0 && ally.side === t.side && ally.id !== t.id) {
          ally.shield = (Number(ally.shield) || 0) + shieldVal;
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [ally.id],
            src_type: 1, src_id: 22600, id: 22600, effect_phase: phase,
            change_type: 200001, change_value: [shieldVal], remove_round: 0,
          });
        }
      });
    }

    // 伐楼那（22220 天海波流）与米迦勒（21700 似神者）受击与攻击标记
    if (hurt > 0 || shieldHurt > 0) {
      actor.hasAttackedAllies = true;
      if (cfg.nature === 1) {
        t.waterHitsReceived = (t.waterHitsReceived || 0) + 1;
      }
      if (natureOf(t.type) === 1) {
        actor.attackedWaterAllies = actor.attackedWaterAllies || [];
        actor.attackedWaterAllies.push({ targetId: t.id, maxHp: t.maxHp || t.hp, rounds: 2 });
      }
      if (battleState) {
        battleState.samsaraEvents = (battleState.samsaraEvents || 0) + 1;
      }
    }

    // 拉（20920 光耀衍射）：单体攻击对另一名敌方造成50%伤害
    if (actor.talent === 20920 && targets.length === 1 && (hurt > 0 || shieldHurt > 0)) {
      const otherFoes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side && u.id !== t.id);
      if (otherFoes.length > 0) {
        const splashTar = otherFoes[Math.floor(rnd() * otherFoes.length)];
        const splashDmg = Math.max(1, Math.floor(hurt * 0.50));
        splashTar.hp = Math.max(0, splashTar.hp - splashDmg);
        results.push({
          target: splashTar.id,
          hurt: splashDmg,
          final_hp: splashTar.hp,
          shield_hurt: 0,
          final_shield: Math.max(0, splashTar.shield || 0),
          extra: 0,
        });
        if (battleState) battleState.samsaraEvents = (battleState.samsaraEvents || 0) + 1;
      }
    }

    // 努阿达（20720 银臂军神）：拳系技能造成克制伤害后50%几率物攻+1
    if (actor.talent === 20720 && isPunchSkill(cfg.id) && rel === 1 && (hurt > 0 || shieldHurt > 0) && rnd() < 0.50) {
      const delta = gainStat(actor, 101, 1, { effects: wakeEffects, srcId: 20720, atkId: actor.id, srcServantId: actor.id, phase });
      if (delta > 0) {
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 20720,
          id: PROP_FEATURE_IDS[101],
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(101, delta, (actor.statLevels && actor.statLevels[101]) || 0)],
          remove_round: 0,
        });
      }
    }

    // 亚巴顿（21740 亡之散布者）：击倒敌方誓灵时，将其负面能力等级转移给敌方随机一名存活誓灵
    if (actor.talent === 21740 && t.side !== actor.side && t.hp > 0 && after <= 0 && !t.pendingFaint) {
      const negChanges = [];
      if (t.statLevels) {
        [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
          const lv = t.statLevels[p] || 0;
          if (lv < 0) negChanges.push({ prop: p, stage: lv });
        });
      }
      if (negChanges.length > 0) {
        const enemyAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side && u.id !== t.id);
        if (enemyAllies.length > 0) {
          const recipient = enemyAllies[Math.floor(rnd() * enemyAllies.length)];
          recipient.statLevels = recipient.statLevels || {};
          const encoded = [];
          negChanges.forEach(nc => {
            const oldLv = recipient.statLevels[nc.prop] || 0;
            const newLv = Math.max(-6, oldLv + nc.stage);
            recipient.statLevels[nc.prop] = newLv;
            const an = PROP_ATTR_NAMES[nc.prop];
            if (an) recipient[an] = newLv;
            encoded.push(encodeAttrVal(nc.prop, nc.stage, newLv));
          });
          wakeEffects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [recipient.id],
            src_type: 1,
            src_id: 21740,
            id: 21740,
            effect_phase: phase,
            change_type: 100000,
            change_value: encoded,
            remove_round: 0,
          });
        }
      }
    }

    // Phase 6 受创后即时反应：
    // 尼曼（23170 身沐血衣）：全场受创叠血污
    if (hurt > 0 || shieldHurt > 0) {
      (allUnits || []).filter(u => u && u.hp > 0 && u.talent === 23170).forEach(nemain => {
        nemain.nemainBlood = Math.min(15, (nemain.nemainBlood || 0) + 1);
      });
    }

    // 提尔（22960 提尔之手）：记录造成伤害的目标
    if (actor.talent === 22960 && (hurt > 0 || shieldHurt > 0)) {
      t.hitByTyr = true;
    }

    // 克塔亚特（22790 接触融合）：造成伤害建立4回合链接
    if (actor.talent === 22790 && (hurt > 0 || shieldHurt > 0)) {
      t.cthyllaBoundRounds = 4;
      t.cthyllaBoundUnitId = actor.id;
    }

    // 努特（22830 死亡之风）：暗技能施加诅咒，风技能群传
    // （三百一十三：CfgBuff[22830]「亡者的诅咒」带 icon——施加/群传补 300019，
    //   回合末 curseOfDead 递减归零处补 300020）
    if (actor.talent === 22830 && (hurt > 0 || shieldHurt > 0)) {
      if (cfg.nature === 6) {
        t.curseOfDead = 3;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 22830, id: 22830, effect_phase: phase,
          change_type: 300019, change_value: [encodeBuffVal(22830, 1)], remove_round: 3,
        });
      } else if (cfg.nature === 3 && t.curseOfDead > 0) {
        (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side).forEach(foe => {
          foe.curseOfDead = 3;
          wakeEffects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [foe.id],
            src_type: 1, src_id: 22830, id: 22830, effect_phase: phase,
            change_type: 300019, change_value: [encodeBuffVal(22830, 1)], remove_round: 3,
          });
        });
      }
    }

    // 兰斯洛特（23010 湖夜祈祷）：受到抵抗伤害提升较高攻击与速度各1级
    if (rel === 2 && (hurt > 0 || shieldHurt > 0)) {
      const hasLancelot = (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 23010);
      if (hasLancelot) {
        const atkP = ((t.attrs && t.attrs.phy_atk) >= (t.attrs && t.attrs.mag_atk)) ? 101 : 102;
        t.statLevels = t.statLevels || {};
        [atkP, 105].forEach(p => {
          t.statLevels[p] = Math.min(6, (t.statLevels[p] || 0) + 1);
          const an = PROP_ATTR_NAMES[p];
          if (an) t[an] = t.statLevels[p];
        });
      }
    }

    // 弗丽嘉（22970 守秘者）：己方被克制或抵抗后赋能下次伤害+60%
    if ((rel === 1 || rel === 2) && (hurt > 0 || shieldHurt > 0)) {
      (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side && u.talent === 22970).forEach(f => {
        f.friggaNextBonus = 0.60;
      });
    }

    // 圣器「受到克制伤害后属性提升」族（复仇之刃/佛拉格拉克/轰击之枪/布里欧纳克/勇者的战车/太阳神的战车）
    // CfgItems desc：「受到克制伤害后，[物攻/魔攻/速度]上升N级」。rel===1 = 攻击方克制受击方。
    // 官方特性飘字：30851/30861/30871/30881/30891/30901（act=20001 属性上升动画）。
    // ⚠️ 只在真有伤害时触发（被免疫/0 伤害不算"受到克制伤害"）；上限 ±6 与其它属性变化一致。
    if (rel === 1 && (hurt > 0 || shieldHurt > 0) && t.relicHurtByWeek) {
      const hb = t.relicHurtByWeek;
      if (hb && hb.prop) {
        t.statLevels = t.statLevels || {};
        const oldLv = t.statLevels[hb.prop] || 0;
        const newLv = Math.max(-6, Math.min(6, oldLv + (hb.delta || 1)));
        const realDelta = newLv - oldLv;
        if (realDelta !== 0) {
          t.statLevels[hb.prop] = newLv;
          const an = PROP_ATTR_NAMES[hb.prop];
          if (an) t[an] = newLv;
          wakeEffects.push({
            trigger_count: 0,
            // ⚠️ atk_servant_id 必须是**本次行动的攻击者**：客户端 FightLoop.checkFeature
            // 用 curEffData.atk_id 去 featureDic[src_type][index*100+4] 里取桶，
            // 填受击者 id 会导致查不到 → 效果被静默丢弃（2026-10-18 真机实证：30881 到了但无飘字）。
            atk_servant_id: actor.id,
            src_servant_id: t.id,
            tar_servant_ids: [t.id],
            src_type: 1, // FIGHT_EFF_FEATURE（必须命中客户端 FightFeature 表）
            src_id: hb.feature,
            id: hb.feature,
            effect_phase: phase,
            change_type: 100000, // FIGHT_EFF_CHANGE_TYPE_ATTR
            change_value: [encodeAttrVal(hb.prop, realDelta, newLv)],
            remove_round: 0,
          });
        }
      }
    }

    // 玄武（23290 隐忍的回击）：玄武受创赋能全队
    if (t.talent === 23290 && (hurt > 0 || shieldHurt > 0)) {
      const hasBaihu = (allUnits || []).some(b => b && b.hp > 0 && b.side === t.side && b.talent === 23300);
      const inc = hasBaihu ? 0.30 : 0.20;
      (allUnits || []).filter(u => u && u.hp > 0 && u.side === t.side).forEach(ally => {
        ally.xuanwuNextBonus = (ally.xuanwuNextBonus || 0) + inc;
      });
    }

    // 香风智乃（22860 小小看板娘）：受创叠层
    if (hurt > 0 || shieldHurt > 0) {
      const hasChinoDef = (allUnits || []).some(u => u && u.hp > 0 && u.side === t.side && u.talent === 22860);
      if (hasChinoDef) {
        const maxC = isGochuumon(t.type) ? 8 : 5;
        if (cfg.type === 1) t.chinoPhyStacks = Math.min(maxC, (t.chinoPhyStacks || 0) + 1);
        else t.chinoMagStacks = Math.min(maxC, (t.chinoMagStacks || 0) + 1);
      }
    }

    // 雪女-小春日和（23210 霜寒侵蚀）：暴雨下受2次攻击追加50%魔攻额外真伤
    if (hurt > 0 || shieldHurt > 0) {
      t.hitsTakenThisRound = (t.hitsTakenThisRound || 0) + 1;
      if (curWeather === WEATHER_IDS.RAIN && t.hitsTakenThisRound === 2) {
        const snowLady = (allUnits || []).find(u => u && u.hp > 0 && u.side !== t.side && u.talent === 23210 && !u.frostErosionDone);
        if (snowLady) {
          snowLady.frostErosionDone = true;
          const extraDmg = Math.max(1, Math.floor((snowLady.attrs.mag_atk || 100) * 0.50));
          after = Math.max(0, after - extraDmg);
        }
      }
    }

    // 阿特洛波斯（23060 绞杀）：敌方血量下降低于15%时立即斩杀扣除15%最大生命
    if (after > 0 && !t.strangledThisRound) {
      const atropos = (allUnits || []).find(u => u && u.hp > 0 && u.side !== t.side && u.talent === 23060);
      if (atropos) {
        const ov = atropos.talentParamOverride || {};
        const line = Number(ov.hpLine) > 0 ? Number(ov.hpLine) : 0.15;
        const cutPct = Number(ov.dmg) > 0 ? Number(ov.dmg) : 0.15;
        const maxH = t.maxHp || (t.attrs && t.attrs.hp) || t.hp;
        if ((after / maxH) < line) {
          t.strangledThisRound = true;
          const cut = Math.max(1, Math.floor(maxH * cutPct));
          after = Math.max(0, after - cut);
        }
      }
    }

    // 玉子烧（23120 软绵回忆）：受创施加已损生命护盾
    if (hurt > 0) {
      const tamagoyaki = (allUnits || []).find(u => u && u.hp > 0 && u.side === t.side && u.talent === 23120);
      if (tamagoyaki && (tamagoyaki.tamagoyakiCooldown || 0) <= 0) {
        tamagoyaki.tamagoyakiCooldown = 3;
        const maxH = t.maxHp || (t.attrs && t.attrs.hp) || t.hp;
        const lostHp = Math.max(0, maxH - after);
        const shieldAdd = Math.max(1, Math.round(lostHp * 0.50));
        t.shield = (t.shield || 0) + shieldAdd;
        // 演出：护盾值本身已经随本目标的 final_shield 下发（本循环末尾 results.push），
        // 这里只补一个 change_value=0 的护盾特效条目，避免客户端把护盾加两遍。
        if (after > 0) {
          talentAfterEffects.push(featureFxEffect(tamagoyaki, 23120, FX_23120, 200001, [0], [t.id], phase));
        }
      }
    }

    // 北京烤鸭（23090 傲娇反击）：受直接技能伤害对来源及同排反击威力50火魔攻
    // 2026-10-20 修复：原实现只改 ct.hp，不发任何事件 → 客户端既没有反击数字也没有演出。
    // 现在把每一次反击包成一条"天赋演出"effect（src_id=23090 供横幅、id=230901 供动画），
    // 客户端 FeatureLoop 会据此合成一次行动并播 P_gr 特效；after<=0（烤鸭被这一击打死）不反击。
    if (t.talent === 23090 && (hurt > 0 || shieldHurt > 0) && actor && actor.hp > 0 && after > 0) {
      const sameRowEnemies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.pos && actor.pos && u.pos[1] === actor.pos[1]);
      const counterTargets = sameRowEnemies.length > 0 ? sameRowEnemies : [actor];
      counterTargets.forEach(ct => {
        const pAtk = (t.attrs ? t.attrs.mag_atk : (t.mag_atk || 100)) * attrLvMul((t.statLevels && t.statLevels[102]) || 0);
        const pDef = (ct.attrs ? ct.attrs.mag_def : (ct.mag_def || 100)) * attrLvMul((ct.statLevels && ct.statLevels[104]) || 0);
        const counterDmg = Math.max(1, Math.round((50 * pAtk) / (pAtk + pDef) * 1.5 * naturePer(natureRelate(2, ct.nature))));
        ct.hp = Math.max(0, ct.hp - counterDmg);
        // 伤害走 change_type=200000（客户端按 -change_value 算 hurt），不塞进 results——
        // 否则 fight_list 与特性演出会各弹一次数字。
        talentAfterEffects.push(featureFxEffect(t, 23090, FX_23090, 200000, [-counterDmg], [ct.id], phase));
      });
    }

    // 尼曼（23170 身沐血衣）：造成伤害后分摊所有血污给敌方全体，敌方满5层全能力-1
    if (actor.talent === 23170 && (hurt > 0 || shieldHurt > 0) && (actor.nemainBlood || 0) > 0) {
      const blood = actor.nemainBlood;
      actor.nemainBlood = 0;
      const foes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
      if (foes.length > 0) {
        const perFoe = Math.max(1, Math.floor(blood / foes.length));
        foes.forEach(f => {
          f.nemainBloodFoe = (f.nemainBloodFoe || 0) + perFoe;
            while (f.nemainBloodFoe >= 5) {
              f.nemainBloodFoe -= 5;
              [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
                gainStat(f, p, -1, { effects: wakeEffects, srcId: 23170, atkId: actor.id, srcServantId: actor.id, phase });
              });
            }
        });
      }
    }

        totalDealt += Math.max(0, hurt) + Math.max(0, shieldHurt);
    if (hurt > 0 || shieldHurt > 0) damagedTargets.push(t);
    // 圣器吸血（天钿 12% / 理世特调咖啡 5%）：CfgItems「造成伤害时可恢复伤害数值N%的生命」。
    // 只在真的造成伤害时回，按本次命中实伤计算；上限为最大生命（溢出丢弃，桐间纱路转化护盾属专属联动）。
    if (actor.relicDmg && actor.relicDmg.lifesteal && hurt > 0 && actor.hp > 0) {
      const maxH = actor.maxHp || (actor.attrs && actor.attrs.hp) || actor.hp;
      const lsRaw = Math.max(1, Math.round(hurt * actor.relicDmg.lifesteal));
      const heal = Math.min(maxH - actor.hp, lsRaw);
      // 理世特调咖啡（纱路专属）：溢出的生命回复转化为护盾
      const exclLS = actor.relicMisc && actor.relicMisc.excl;
      if (exclLS && exclLS.syaroOverflowShield && lsRaw > heal) {
        const overflow = lsRaw - heal;
        actor.shield = (actor.shield || 0) + overflow;
        // 2026-10-27：护盾补 200001（静默 60120），否则转化盾不可见
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
          src_type: 3, src_id: 0, id: 60120, effect_phase: phase,
          change_type: 200001, change_value: [overflow], remove_round: 0,
        });
      }
      if (heal > 0) {
        actor.hp += heal;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 30531, // 回复的甘露（官方治疗展示条目）
          id: 30531,
          effect_phase: phase,
          change_type: 200000,
          change_value: [heal],
          remove_round: 0,
        });
      }
    }
    // 金刚杵（18000004）：攻击破坏目标的屏障（护盾）效果；破除后自身较高攻击提升 1 级。
    // 引擎里"屏障"即 shield（元素护盾是独立字段，官方 desc 用「屏障」泛指护盾类）。
    if (actor.relicMisc && actor.relicMisc.breakBarrier && (Number(t.shield) || 0) > 0) {
      t.shield = 0;
      const atkProp = ((actor.attrs && actor.attrs.phy_atk) >= (actor.attrs && actor.attrs.mag_atk)) ? 101 : 102;
      actor.statLevels = actor.statLevels || {};
      const oLv = actor.statLevels[atkProp] || 0;
      const nLv = Math.max(-6, Math.min(6, oLv + 1));
      if (nLv !== oLv) {
        actor.statLevels[atkProp] = nLv;
        const an = PROP_ATTR_NAMES[atkProp];
        if (an) actor[an] = nLv;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id,
          tar_servant_ids: [actor.id], src_type: 1,
          src_id: PROP_FEATURE_IDS[atkProp] || 20001, id: PROP_FEATURE_IDS[atkProp] || 20001,
          effect_phase: phase, change_type: 100000,
          change_value: [encodeAttrVal(atkProp, 1, nLv)], remove_round: 0,
        });
      }
    }
    // 鲷鱼烧：本场每受到 1 次技能伤害记一层（供攻击乘区读取）
    if (hurt > 0 && t.relicMisc && t.relicMisc.stackDmgPerHurt) {
      t.relicHurtStacks = (t.relicHurtStacks || 0) + 1;
    }
    // —— 联动圣器专属受击触发（2026-10-25 家族落地）——
    const exclT1 = t.relicMisc && t.relicMisc.excl;
    if (hurt > 0 && exclT1) {
      // 冰结傀儡（四糸乃专属）：受到攻击伤害时，攻击者物攻下降 1 级
      if (exclT1.yoshinoAtkDown && actor.hp > 0) {
        gainStat(actor, 101, -exclT1.yoshinoAtkDown, { effects: wakeEffects, srcId: PROP_FEATURE_IDS[101], atkId: t.id, srcServantId: t.id, phase });
      }
      // 记忆的笔记本（吉普莉尔专属）：每受到一次伤害，暴击能力等级提升 1 级（此前标记零消费）
      if (exclT1.jibrilCritOnHurt && t.hp > 0) {
        gainStat(t, 111, exclT1.jibrilCritOnHurt, { effects: wakeEffects, srcId: PROP_FEATURE_IDS[111], atkId: actor.id, srcServantId: t.id, phase });
      }
      // 鹊儿圣器（雀儿专属）：受到暴击伤害时，随机 1 项攻击 +1 级
      if (crit && exclT1.sparrowCritAtkUp && t.hp > 0) {
        const spProp = Math.random() < 0.5 ? 101 : 102;
        gainStat(t, spProp, exclT1.sparrowCritAtkUp, { effects: wakeEffects, srcId: PROP_FEATURE_IDS[spProp], atkId: actor.id, srcServantId: t.id, phase });
      }
    }
    // 冰糖燕窝：触发减伤时随机一项能力 +1
    if (relicHurtMitTriggered && t.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(rnd() * props.length)];
      t.statLevels = t.statLevels || {};
      const oldLv = t.statLevels[p] || 0;
      const newLv = Math.max(-6, Math.min(6, oldLv + 1));
      if (newLv !== oldLv) {
        t.statLevels[p] = newLv;
        const an = PROP_ATTR_NAMES[p];
        if (an) t[an] = newLv;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id,
          tar_servant_ids: [t.id], src_type: 1,
          src_id: PROP_FEATURE_IDS[p] || 20001, id: PROP_FEATURE_IDS[p] || 20001,
          effect_phase: phase, change_type: 100000,
          change_value: [encodeAttrVal(p, 1, newLv)], remove_round: 0,
        });
      }
    }
    // 圣器「受击随机能力提升」（释天 17001004：携带者受到伤害后，随机 1 项能力提升 1 级）。
    // 每**次受击**触发一次（不是每段伤害），与天赋的受击触发同区。上限 +6。
    if (hurt > 0 && t.relicDmg && t.relicDmg.hurtRandomStatUp && t.hp >= 0 && actor.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(rnd() * props.length)];
      t.statLevels = t.statLevels || {};
      const oldLv = t.statLevels[p] || 0;
      const newLv = Math.max(-6, Math.min(6, oldLv + t.relicDmg.hurtRandomStatUp));
      const d = newLv - oldLv;
      if (d !== 0) {
        t.statLevels[p] = newLv;
        const an = PROP_ATTR_NAMES[p];
        if (an) t[an] = newLv;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: t.id,
          tar_servant_ids: [t.id],
          src_type: 1,
          // ⚠️ src_type=1 的 id/src_id 必须是客户端 FightFeature 表内的**特性** ID，不能放圣器 typeId
          //（否则客户端 GetFeature(x, true) 打印「不存在的特性ID」）。改用通用属性上升特性 20001~20008。
          src_id: PROP_FEATURE_IDS[p] || 20001,
          id: PROP_FEATURE_IDS[p] || 20001,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(p, d, newLv)],
          remove_round: 0,
        });
      }
    }
    // 救活类天赋（玉兔 22950 长生不老药复活）设置 revivedHp——覆盖纯伤害口径的 after（致命时 0），
    // 否则复活目标会在本行被写死（2026-10-12 phase6 #127 实证）。奥西里斯走 after=1 不经此路径
    if (revivedHp > 0) after = revivedHp;
    // 甘狄拔（18001004）：击倒敌方后随机一项攻击提升 1 级（物攻/魔攻各半，取较高者更贴近"攻击"语义）
    if (after <= 0 && t.hp > 0 && actor.relicMisc && actor.relicMisc.onKillRandomAtk && actor.hp > 0) {
      const atkProp = ((actor.attrs && actor.attrs.phy_atk) >= (actor.attrs && actor.attrs.mag_atk)) ? 101 : 102;
      actor.statLevels = actor.statLevels || {};
      const oLv = actor.statLevels[atkProp] || 0;
      const nLv = Math.max(-6, Math.min(6, oLv + actor.relicMisc.onKillRandomAtk));
      if (nLv !== oLv) {
        actor.statLevels[atkProp] = nLv;
        const an = PROP_ATTR_NAMES[atkProp];
        if (an) actor[an] = nLv;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id,
          tar_servant_ids: [actor.id], src_type: 1,
          src_id: PROP_FEATURE_IDS[atkProp] || 20001, id: PROP_FEATURE_IDS[atkProp] || 20001,
          effect_phase: phase, change_type: 100000,
          change_value: [encodeAttrVal(atkProp, 1, nLv)], remove_round: 0,
        });
      }
    }
    if (skillRule && skillRule.postDamageRandomStat && Number(hurt) > 0) {
      gainStat(actor, [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], skillRule.postDamageRandomStat,
        { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    }
    // P1 简单维修（10329）：目标本回合不会被击倒 → 致命伤害保留 1 HP（一次性）
    if (after <= 0 && t.hp > 0 && (t.noKnockdownRounds || 0) > 0) { after = 1; t.noKnockdownRounds = 0; }
    results.push({ target: t.id, hurt, final_hp: after, shield_hurt: shieldHurt, final_shield: Math.max(0, t.shield || 0), extra, rel });
    // 落账并回净变化：results.final_hp 保持纯伤害口径，客户端 final_hp + 200000 演出(delta)
    // 与服务端终值一致。after=0（击杀）不并——治疗不得复活、追加伤害无需再补刀。
    t.hp = after > 0 ? Math.max(0, after + (t.hp - preLandHp)) : after;
    // 沙罗曼达（20790 爆炎炼成）：使用火属性技能造成伤害时，30%几率产生爆炸，
    // 使目标受到（当前生命值20%）的追加伤害——放主伤害落账后：按受击后当前生命算，且为真伤（不走护盾）
    if (actor.talent === 20790 && Number(cfg.nature) === 2 && hurt > 0 && t.hp > 0 && rnd() < 0.30) {
      const boom = Math.max(1, Math.floor(t.hp * 0.20));
      t.hp = Math.max(0, t.hp - boom);
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 20790, id: 20790, effect_phase: phase,
        change_type: 200000, change_value: [-boom], remove_round: 0,
      });
    }

    // —— 批次C 受击联动族（二百五十二）——
    // 魔女之眼（20250 美杜莎）：自身受到攻击伤害后，攻击者速度下降2级，下回合技能优先度-1
    if (t.talent === 20250 && hurt > 0 && actor.hp > 0) {
      gainStat(actor, 105, -2, { effects: wakeEffects, srcId: 20250, atkId: t.id, srcServantId: actor.id, phase });
      actor.nextPriorityBonus = -1;
      actor.nextPriorityRound = currentRound + 1;
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [actor.id],
        src_type: 1, src_id: 20250, id: 20250, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    }
    // 守护者之证（20980 斯芬克斯）：己方其他誓灵受到攻击伤害后，天赋持有者随机1项防御上升1级
    if (hurt > 0) {
      (allUnits || []).forEach(sph => {
        if (sph && sph.hp > 0 && sph.talent === 20980 && sph.side === t.side && sph.id !== t.id) {
          gainStat(sph, Math.random() < 0.5 ? 103 : 104, 1, { effects: wakeEffects, srcId: 20980, atkId: actor.id, srcServantId: sph.id, phase });
        }
      });
    }
    // 正体不明（21410 鵺）受击段：受到攻击伤害后自身下回合技能优先度+2（免克制/免暴击/免异常在各自管线口）
    if (t.talent === 21410 && hurt > 0) {
      t.nextPriorityBonus = 2;
      t.nextPriorityRound = currentRound + 1;
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 21410, id: 21410, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    }
    // 独眼暴乱者（21570 基克洛普斯）记仇段：受到伤害后记下伤害来源，下次攻击对象若是该来源则对其伤害提升100%
    if (t.talent === 21570 && hurt > 0 && actor.hp > 0) {
      t.cyclopsGrudgeId = actor.id;
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 21570, id: 21570, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    }
    // 燃点引爆（20800 鬼火）受击段：受到攻击伤害时使攻击者变为易燃状态
    if (t.talent === 20800 && hurt > 0 && actor.hp > 0 && !actor.flammable) {
      actor.flammable = true;
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [actor.id],
        src_type: 1, src_id: 20800, id: 20800, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    }
    // —— 批次G-2 施伤/受击联动（二百五十六）——
    // 灾厄的钟声（20090 报丧女妖）：使用攻击技能造成伤害时，10% 使对象混乱
    if (actor.talent === 20090 && hurt > 0 && t.hp > 0 && Number(cfg.power) > 0 && rnd() < 0.10) {
      applyExclusiveBuff(actor, t, BUFF_IDS.CONFUSION, 100, 3, { effects: wakeEffects, phase });
    }
    // 海妖之歌（20320 塞壬）：声音类技能造成伤害时 20% 使对象睡眠
    if (actor.talent === 20320 && hurt > 0 && t.hp > 0 && isSoundSkill(cfg.id) && rnd() < 0.20) {
      applyExclusiveBuff(actor, t, BUFF_IDS.SLEEP, 100, 3, { effects: wakeEffects, phase });
    }
    // 鲜血狂宴（20680 德古拉）：直接攻击造成伤害后回复总伤害 25%
    if (actor.talent === 20680 && hurt > 0 && actor.hp > 0) {
      const drain = Math.max(1, Math.round(hurt * 0.25));
      actor.hp = Math.min(actor.maxHp, actor.hp + drain);
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 1, src_id: 20680, id: 20680, effect_phase: phase,
        change_type: 200000, change_value: [drain], remove_round: 0,
      });
    }
    // 不给糖就捣蛋（20690 杰克南瓜）：对携带圣器目标 → 随机一项+1；无圣器 → 使其-1
    if (actor.talent === 20690 && hurt > 0 && t.hp > 0) {
      const prop = [101, 102, 103, 104, 105][Math.floor(rnd() * 5)];
      if (t.relicId) gainStat(actor, prop, 1, { effects: wakeEffects, srcId: 20690, atkId: actor.id, srcServantId: actor.id, phase });
      else gainStat(t, prop, -1, { effects: wakeEffects, srcId: 20690, atkId: actor.id, srcServantId: t.id, phase });
    }
    // 强取豪夺（20890 蒂阿兹）：伤害时目标随机一项为正的能力-1，自身该项+2
    if (actor.talent === 20890 && hurt > 0 && t.hp > 0) {
      const positive = [101, 102, 103, 104, 105].filter(pp => ((t.statLevels && t.statLevels[pp]) || 0) > 0);
      if (positive.length > 0) {
        const prop = positive[Math.floor(rnd() * positive.length)];
        gainStat(t, prop, -1, { effects: wakeEffects, srcId: 20890, atkId: actor.id, srcServantId: t.id, phase });
        gainStat(actor, prop, 2, { effects: wakeEffects, srcId: 20890, atkId: actor.id, srcServantId: actor.id, phase });
      }
    }
    // 束缚绞首（20910 络新妇）：造成伤害时 50% 使目标速度下降1级（伤害条件在乘区）
    if (actor.talent === 20910 && hurt > 0 && t.hp > 0 && rnd() < 0.50) {
      gainStat(t, 105, -1, { effects: wakeEffects, srcId: 20910, atkId: actor.id, srcServantId: t.id, phase });
    }
    // 雪靴女神（21450 斯卡娣）：攻击本回合已行动目标 → 自身速度、命中各+1；攻击未行动目标 → 目标物防、闪避各-1
    if (actor.talent === 21450 && hurt > 0) {
      if (t.actedThisRound) {
        gainStat(actor, 105, 1, { effects: wakeEffects, srcId: 21450, atkId: actor.id, srcServantId: actor.id, phase });
        gainStat(actor, 113, 1, { effects: wakeEffects, srcId: 21450, atkId: actor.id, srcServantId: actor.id, phase });
      } else if (t.hp > 0) {
        gainStat(t, 103, -1, { effects: wakeEffects, srcId: 21450, atkId: actor.id, srcServantId: t.id, phase });
        gainStat(t, 115, -1, { effects: wakeEffects, srcId: 21450, atkId: actor.id, srcServantId: t.id, phase });
      }
    }
    // 深海援救（21580 琉喀忒亚）伤害侧：己方誓灵受到水属性技能伤害后，随机1项攻击和防御提升1级
    if (hurt > 0 && Number(cfg.nature) === 1) {
      (allUnits || []).forEach(lc => {
        if (lc && lc.hp > 0 && lc.talent === 21580 && lc.side === t.side) {
          gainStat(lc, ((lc.attrs && lc.attrs.phy_atk >= lc.attrs.mag_atk) ? 101 : 102), 1,
            { effects: wakeEffects, srcId: 21580, atkId: t.id, srcServantId: lc.id, phase });
          gainStat(lc, rnd() < 0.5 ? 103 : 104, 1,
            { effects: wakeEffects, srcId: 21580, atkId: t.id, srcServantId: lc.id, phase });
        }
      });
    }
    // 毒龙之体（22250 那伽）受击段：敌方对其造成伤害后，回合结束时损失 10%×3回合
    if (t.talent === 22250 && hurt > 0 && actor.side !== t.side) {
      (t.nagaMarked || (t.nagaMarked = {}))[actor.id] = 3;
    }
    // 鬼面（22300 夜叉）：敌方誓灵第二次受到夜叉攻击时 100% 畏惧
    if (actor.talent === 22300 && hurt > 0 && t.hp > 0) {
      t.yashaHitCount = (t.yashaHitCount || 0) + 1;
      if (t.yashaHitCount >= 2) {
        t.yashaHitCount = 0;
        applyFlinch(t, wakeEffects, phase, 22300, actor.id);
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 22300, id: 90501, effect_phase: phase,
          change_type: 0, change_value: [], remove_round: 0,
        });
      }
    }
    // 百搭料理（23130 白米饭）：受到一次技能攻击伤害后，为己方生命最低的誓灵恢复10%生命
    if (t.talent === 23130 && hurt > 0) {
      const alliesB = (allUnits || []).filter(a => a && a.hp > 0 && a.side === t.side);
      if (alliesB.length > 0) {
        const low = alliesB.slice().sort((a, b) => (a.hp / (a.maxHp || 1)) - (b.hp / (b.maxHp || 1)))[0];
        const heal = Math.max(1, Math.floor((low.maxHp || (low.attrs && low.attrs.hp) || low.hp) * 0.10));
        low.hp = Math.min(low.maxHp, low.hp + heal);
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: t.id, tar_servant_ids: [low.id],
          src_type: 1, src_id: 23130, id: 23130, effect_phase: phase,
          change_type: 200000, change_value: [heal], remove_round: 0,
        });
      }
    }
    // 异兽变换（20330）施放侧：记录本次技能属性作为"当前属性"；造成克制伤害后随机一项能力+1
    if (actor.talent === 20330) {
      actor.chimeraNature = Number(cfg.nature);
      if (rel === 1 && hurt > 0) {
        gainStat(actor, [101, 102, 103, 104, 105][Math.floor(rnd() * 5)], 1,
          { effects: wakeEffects, srcId: 20330, atkId: actor.id, srcServantId: actor.id, phase });
      }
    }

    // —— 批次G-2d 技能（二百五十六）——
    // 电浆喷射（10346）：消耗全部电浆能量，每点 +25% 伤害，且随机降低一项防御等级1级
    if (cfg.id === 10346 && hurt > 0 && t.hp > 0) {
      const pe = Number(actor.plasmaEnergy) || 0;
      if (pe > 0) {
        actor.plasmaEnergy = 0;
        const extra = Math.max(1, Math.round(hurt * 0.25 * pe));
        t.hp = Math.max(0, t.hp - extra);
        results.push({ target: t.id, hurt: extra, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
        gainStat(t, rnd() < 0.5 ? 103 : 104, -1, { effects: wakeEffects, srcId: 10346, atkId: actor.id, srcServantId: t.id, phase });
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 10346, id: 10346, effect_phase: phase,
          change_type: 200000, change_value: [-extra], remove_round: 0,
        });
      }
    }
    // 西兰岛之殇（10357）：每造成目标 15% 最大生命的伤害，随机夺取 1 级正向能力等级
    if (cfg.id === 10357 && hurt > 0 && t.hp > 0) {
      const steps = Math.floor(hurt / Math.max(1, t.maxHp * 0.15));
      for (let i = 0; i < Math.min(steps, 4); i++) {
        const positive = [101, 102, 103, 104, 105].filter(pp => ((t.statLevels && t.statLevels[pp]) || 0) > 0);
        if (!positive.length) break;
        const prop = positive[Math.floor(rnd() * positive.length)];
        gainStat(t, prop, -1, { effects: wakeEffects, srcId: 10357, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
        gainStat(actor, prop, 1, { effects: wakeEffects, srcId: 10357, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
      }
    }
    // 崩岩粉碎拳（10060）：沙尘天气时对目标周围造成 50% 溅射
    if (cfg.id === 10060 && hurt > 0 && curWeather === WEATHER_IDS.SANDSTORM) {
      const around = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side && u.id !== t.id
        && Math.abs((u.pos && u.pos[0] || 0) - (t.pos && t.pos[0] || 0)) <= 1
        && Math.abs((u.pos && u.pos[1] || 0) - (t.pos && t.pos[1] || 0)) <= 1);
      around.forEach(o => {
        const dmg = Math.max(1, Math.round(hurt * 0.50));
        o.hp = Math.max(0, o.hp - dmg);
        results.push({ target: o.id, hurt: dmg, final_hp: o.hp, shield_hurt: 0, final_shield: Math.max(0, o.shield || 0), extra: 0 });
      });
    }
    // 不屈之心（20450 精卫）：畏惧时全能力+1（在畏惧被施加处难挂钩，改为回合末检查）
    // 正义之心（20340 格里芬）速度侧在 effectiveSpeed；伤害侧在乘区

    // 燃点引爆（20800 鬼火）施伤段：造成伤害时使目标进入易燃状态
    if (actor.talent === 20800 && hurt > 0 && t.hp > 0 && !t.flammable) {
      t.flammable = true;
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 20800, id: 20800, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    }

    // —— 批次F 状态标记消费/施加（二百五十四）——
    // 杀戮波动（10418）：对拥有血污的目标再次造成 n*16% 的伤害（n=层数）
    if (cfg.id === 10418 && hurt > 0 && t.hp > 0 && (t.bloodStainStacks || 0) > 0) {
      const extra = Math.max(1, Math.round(hurt * 0.16 * t.bloodStainStacks));
      t.hp = Math.max(0, t.hp - extra);
      results.push({ target: t.id, hurt: extra, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
      wakeEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 10418, id: 10418, effect_phase: phase,
        change_type: 200000, change_value: [-extra], remove_round: 0,
      });
    }
    // 如影随形（10275）：造成伤害后留下风行者印记；此后对拥有该印记的目标额外造成 50% 伤害
    if (cfg.id === 10275 && hurt > 0 && t.hp > 0) {
      const marked = Number(t.windWalkerMarkedBy) === Number(actor.id);
      if (marked) {
        const extra = Math.max(1, Math.round(hurt * 0.50));
        t.hp = Math.max(0, t.hp - extra);
        results.push({ target: t.id, hurt: extra, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 10275, id: 10275, effect_phase: phase,
          change_type: 200000, change_value: [-extra], remove_round: 0,
        });
      } else {
        t.windWalkerMarkedBy = actor.id;
        wakeEffects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 10275, id: 10275, effect_phase: phase,
          change_type: 0, change_value: [], remove_round: 0,
        });
      }
    }
    // —— 批次D 等级操作技（二百五十二）——
    // 雏凤稚炎（10228）：造成伤害后，随机复制敌方（该目标）最高的一项能力等级；己方该项更高则无效
    if (cfg.id === 10228 && hurt > 0 && t.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const tLv = props.map(pp => (t.statLevels && t.statLevels[pp]) || 0);
      const maxLv = Math.max(...tLv);
      if (maxLv > 0) {
        const cands = props.filter(pp => ((t.statLevels && t.statLevels[pp]) || 0) === maxLv);
        const pick = cands[Math.floor(rnd() * cands.length)];
        const mine = (actor.statLevels && actor.statLevels[pick]) || 0;
        if (mine < maxLv) {
          gainStat(actor, pick, maxLv - mine, { effects: wakeEffects, srcId: 10228, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
        }
      }
    }
    // 泪泉之涌（10334）：造成伤害后清除敌方的正向防御能力等级
    if (cfg.id === 10334 && hurt > 0 && t.hp > 0) {
      [103, 104].forEach(pp => {
        const lv = (t.statLevels && t.statLevels[pp]) || 0;
        if (lv > 0) gainStat(t, pp, -lv, { effects: wakeEffects, srcId: 10334, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
      });
    }
    // 时越狙击（10211）：造成伤害后，使用者下回合对该目标伤害提升25%（批次H1，消费在乘区段）
    if (skillRule && skillRule.nextRoundDmgUpVsTarget && hurt > 0) {
      actor.nextRoundDmgUpVs = actor.nextRoundDmgUpVs || {};
      actor.nextRoundDmgUpVs[t.id] = { pct: skillRule.nextRoundDmgUpVsTarget, round: currentRound + 1 };
    }
    // 智慧之恩（10226）：若造成克制伤害，己方随机1名誓灵50%几率较高一项攻击提升1级
    if (cfg.id === 10226 && hurt > 0 && rel === 1) {
      const alliesAll = (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side);
      if (alliesAll.length > 0 && rnd() * 100 < 50) {
        const pick = alliesAll[Math.floor(rnd() * alliesAll.length)];
        const hi = ((pick.attrs && pick.attrs.phy_atk) >= (pick.attrs && pick.attrs.mag_atk)) ? 101 : 102;
        gainStat(pick, hi, 1, { effects: wakeEffects, srcId: 10226, srcType: 3, atkId: actor.id, srcServantId: pick.id, phase });
      }
    }
    const eh = (skillRule && skillRule.extraHits) || angelExtraHits;
    if (eh && hurt > 0) {
      // 批次H1：countRange 支持「连续攻击2-5次」类随机段数（10052/10206/10221）
      const hitCount = eh.countRange
        ? (eh.countRange[0] + Math.floor(rnd() * (eh.countRange[1] - eh.countRange[0] + 1)))
        : (eh.count || 0);
      for (let i = 0; i < hitCount && t.hp > 0; i++) {
        const mul = eh.decay ? Math.pow(eh.pct || 1, i + 1) : (eh.pct || 1);
        const dmg = Math.max(1, Math.round(hurt * mul));
        t.hp = Math.max(0, t.hp - dmg);
        results.push({ target: t.id, hurt: dmg, final_hp: t.hp, shield_hurt: 0, final_shield: Math.max(0, t.shield || 0), extra: 0 });
      }
    }
    if (skillRule && hurt > 0 && (skillRule.splashRandom || skillRule.splashAll || skillRule.repeatOnStatus)) {
      const others = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side && u.id !== t.id);
      const hit = (list, pct) => list.forEach(o => {
        const dmg = Math.max(1, Math.round(hurt * pct));
        o.hp = Math.max(0, o.hp - dmg);
        results.push({ target: o.id, hurt: dmg, final_hp: o.hp, shield_hurt: 0, final_shield: Math.max(0, o.shield || 0), extra: 0 });
      });
      if (skillRule.splashAll) hit(others, skillRule.splashAll.pct);
      if (skillRule.splashRandom) hit(others.slice().sort(() => Math.random() - 0.5).slice(0, skillRule.splashRandom.count || 1), skillRule.splashRandom.pct);
      if (skillRule.repeatOnStatus) {
        const sts = skillRule.repeatOnStatus.statuses || [];
        hit(others.filter(o => o.buffs && sts.some(s => o.buffs[s])), skillRule.repeatOnStatus.pct);
      }
    }
    // 灼烂歼鬼（17007004 通用段）：物理单体技能命中后，对目标周围（相邻格）敌方造成 10% 伤害
    //（此前 physSingleSplash 标记零消费，2026-10-25 接线；展示与 skillRule 溅射同走 results 行）
    if (hurt > 0 && actor.relicMisc && actor.relicMisc.physSingleSplash
        && Number(cfg.type) === 1 && (EFF_FOE_ONE.has(Number(cfg.effType)) || Number(cfg.effType) === 1007)) {
      const around = (allUnits || []).filter(o => o && o.hp > 0 && o.side !== actor.side && o.id !== t.id
        && o.pos && t.pos && Math.abs((o.pos[0] || 0) - (t.pos[0] || 0)) + Math.abs((o.pos[1] || 0) - (t.pos[1] || 0)) === 1);
      around.forEach(o => {
        const dmg = Math.max(1, Math.round(hurt * actor.relicMisc.physSingleSplash));
        const oShieldHurt = Math.min(o.shield || 0, dmg);
        if (oShieldHurt > 0) o.shield -= oShieldHurt;
        const oHpDmg = dmg - oShieldHurt;
        if (oHpDmg > 0) o.hp = Math.max(0, o.hp - oHpDmg);
        results.push({ target: o.id, hurt: dmg, final_hp: o.hp, shield_hurt: oShieldHurt, final_shield: Math.max(0, o.shield || 0), extra: 0 });
      });
    }
    if (after <= 0 && skillRule && skillRule.onKillInheritDebuff) {
      const debuffs = Object.keys(t.buffs || {}).filter(k => Number(k) >= 50001 && Number(k) <= 50007);
      const living = (allUnits || []).filter(a => a && a.hp > 0 && a.side === t.side && a.id !== t.id);
      if (debuffs.length && living.length) {
        const heir = living[Math.floor(Math.random() * living.length)];
        heir.buffs = heir.buffs || {};
        debuffs.forEach(k => { heir.buffs[k] = t.buffs[k]; });
        t.buffs = {};
      }
    }
    if (after <= 0 && skillRule && skillRule.onKillAllyStat && Number(hurt) > 0) {
      const allies = (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side && a.id !== actor.id);
      for (let i = 0; i < (skillRule.onKillAllyStat.count || 1) && allies.length; i++) {
        const a = allies[Math.floor(Math.random() * allies.length)];
        gainStat(a, [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], skillRule.onKillAllyStat.delta || 1,
          { effects: wakeEffects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
      }
    }
    // 崩坏琴声（10319，批次H3）：击倒敌方 → 该技能使用次数 +1（封顶 cfg.pp）
    if (after <= 0 && skillRule && skillRule.ppRefundOnKill && Number(hurt) > 0) {
      const slot = (actor.skills || []).find(s => Number(s.id) === Number(cfg.id));
      const maxPp = Number((skillCfg(cfg.id) || {}).pp) || 0;
      if (slot && slot.pp < maxPp) slot.pp++;
    }
  });

  // 受击类天赋的演出统一在主伤害结果之后入列（顺序 = 客户端播报顺序：先命中、后反击）
  if (talentAfterEffects.length) {
    for (const e of talentAfterEffects) wakeEffects.push(e);
  }

  // ── 米迦勒 10243 天国复仇（heavenVengeance）：击败目标 → 下次使用改全体 ──
  // 武装/清标都必须在这里（本击结算完的时点）：targetsOfEff 会被 AI 评分反复调用，不能承担清标。
  // 上一发的武装在本发**结算后**消费（无论本发是否命中——"下次使用"的全体 already 发生过）；
  // 本发若有击杀则重新武装，可连锁。空 results（目标为空等 fizzle 场景）只清不武装。
  if (actor && Number(cfg.id) === 10243 && Number(cfg.power) > 0) {
    if (actor.heavenVengeanceArmed) actor.heavenVengeanceArmed = false;
    const killedAny = results.some(e => (Number(e.hurt) || 0) > 0 && Number(e.final_hp) <= 0);
    if (killedAny) actor.heavenVengeanceArmed = true;
  }

  // =========================================================================
  // 复合攻击技：造成伤害后的回复与追加效果（CfgSkillDetail fightDesc 实证，规则见 skill_effect_data.js）
  // 三个带 healPct 的攻击技（10412/10406/10218）旧实现零伤害，2026-10-05 修复
  // =========================================================================
  if (skillRule && totalDealt > 0) {
    const healUnit = (u, amount) => {
      if (!u || u.hp <= 0 || !(amount > 0)) return;
      const amt = Math.round(amount * healReceivedMul(u) * healDealtMul(actor)); // 禁疗 ×0.25；攻方圣器回复量乘区
      const capped = Math.min(u.maxHp, u.hp + amt);
      const gained = capped - u.hp;
      if (gained <= 0) return;
      u.hp = capped;
      // 客户端 FeatureLoop.showFeature 对 src_type=1（特性）的 effect 会拿 id/src_id 查 FightFeature
      // 特性表（第二参 true = 查不到 printError「不存在的特性ID」）——**不能放技能 ID**（10412/10406/10218
      // 都不在表内，2026-10-12 真机 16 连报错实证）。改用官方治疗展示特性 30531「回复的甘露」
      // （FightFeature.lua: act=20015 回血动画 + tips="#tar恢复了#value点生命"，#value=change_value[1]）。
      // src_servant/atk_servant 仍指向施术者，飘字位置/回合归属不受影响。
      wakeEffects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [u.id],
        src_type: 1,
        src_id: 30531,
        id: 30531,
        effect_phase: phase,
        change_type: 200000, // FIGHT_EFF_CHANGE_TYPE_HP（正值=治疗，客户端 FeatureLoop 取负显示）
        change_value: [gained],
        remove_round: 0,
      });
    };
    const pdh = skillRule.postDamageHeal;
    if (pdh) {
      // 天之甘露（10412）：自身回复15%最大生命（与纯治疗分支同为 ceil 口径）
      if (pdh.selfPct) healUnit(actor, Math.ceil(actor.maxHp * pdh.selfPct / 100));
      // 蛋烧冲击（10406）：己方血量比例最低者（含自身）回复15%其最大生命
      if (pdh.lowestAllyPct) {
        let lowest = null, lowestRatio = 2;
        (allUnits || []).forEach(a => {
          if (a && a.hp > 0 && a.side === actor.side) {
            const r = a.hp / a.maxHp;
            if (r < lowestRatio) { lowestRatio = r; lowest = a; }
          }
        });
        if (lowest) healUnit(lowest, Math.ceil(lowest.maxHp * pdh.lowestAllyPct / 100));
      }
      // 重生之风（10218）：使用者回复造成伤害20%，其余己方誓灵回复10%；乱流天气下翻倍
      if (pdh.userDealtPct) {
        const doubled = (pdh.doubleInWeather && curWeather === pdh.doubleInWeather) ? 2 : 1;
        healUnit(actor, Math.ceil(totalDealt * pdh.userDealtPct / 100) * doubled);
        if (pdh.othersPct) {
          (allUnits || []).forEach(a => {
            if (a && a.hp > 0 && a.side === actor.side && a.id !== actor.id) {
              healUnit(a, Math.ceil(a.maxHp * pdh.othersPct / 100) * doubled);
            }
          });
        }
      }
      // 嗜血蝇群（10345）：己方全体恢复造成伤害20%的生命（含使用者，各自按 totalDealt 计）
      if (pdh.alliesDealtPct) {
        (allUnits || []).forEach(a => {
          if (a && a.hp > 0 && a.side === actor.side) {
            healUnit(a, Math.ceil(totalDealt * pdh.alliesDealtPct / 100));
          }
        });
      }
    }
    // 深渊狱火（10322）：被伤害目标（及自身）每回合损失20%最大生命，持续3回合
    if (skillRule.afterDamageDrain) {
      const dr = skillRule.afterDamageDrain;
      damagedTargets.forEach(t => { t.hellfireRounds = dr.rounds; });
      if (dr.includeSelf && actor.hp > 0) actor.hellfireRounds = dr.rounds;
    }
  }
  // 消耗一次性行动增伤
  actor.hwanungBuffDmg = 0;
  actor.friggaNextBonus = 0;
  actor.xuanwuNextBonus = 0;
  actor.actedThisRound = true;
  if (isSoundSkill(cfg.id) && battleState) {
    battleState.soundUsedSide = battleState.soundUsedSide || {};
    battleState.soundUsedSide[actor.side] = true;
  }

  // 德墨忒尔（21250 丰饶之祈）：场上任意誓灵使用土系技能后回复10%生命值且下回合技能增伤10%
  if (cfg.nature === 4) {
    (allUnits || []).forEach(u => {
      if (u && u.hp > 0 && u.talent === 21250) {
        const healAmt = Math.min(u.maxHp - u.hp, Math.max(1, Math.round(u.maxHp * 0.10)));
        if (healAmt > 0) u.hp += healAmt;
        u.demeterNextDmg = (u.demeterNextDmg || 0) + 0.10;
        wakeEffects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1,
          src_id: 21250,
          id: 21250,
          effect_phase: phase,
          change_type: 200000,
          change_value: [healAmt],
          remove_round: 0,
        });
      }
    });
  }

  // 赛特（21630 沙暴掌控）：己方使用风属性技能后标记，下一次土属性技能伤害提高50%
  if (cfg.nature === 3) {
    const hasSeth = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21630);
    if (hasSeth && battleState) {
      battleState.sethWindUsedSide = battleState.sethWindUsedSide || {};
      battleState.sethWindUsedSide[actor.side] = true;
    }
  }
  if (actor && actor.hp > 0 && cfg && cfg.power > 0) {
    actor.lastUsedSkillNature = cfg.nature;
    // 28. 史尔特尔（21220 灭世之炎）：同回合己方每使用一次火属性攻击技能，火攻叠加增伤
    if (cfg.nature === 2 && cfg.power > 0 && battleState) {
      const sideKey = "surtrFireStacks_" + actor.side;
      battleState[sideKey] = (battleState[sideKey] || 0) + 1;
    }
    actor.dealtDamageThisRound = true;
  }
  if (skillRule && skillRule.selfDamageThird && totalDealt > 0 && actor.hp > 0) {
    const self = Math.max(1, Math.round(totalDealt / 3));
    actor.hp = Math.max(0, actor.hp - self);
    wakeEffects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 3, src_id: cfg.id, id: 60120, effect_phase: phase,
      change_type: 200000, change_value: [-self], remove_round: 0,
    });
  }
  results.wakeEffects = wakeEffects;
  return results;
}

// 技能释放后属性等级改变与异常状态应用
function applySkillEffects(actor, cfg, targets, allUnits, actIndex, battleState) {
  // 117. 多闻天（22290 慧伞）：己方能力等级下降时单次至多下降1级
  const hasVaisravana = (allUnits || []).some(u => u && u.hp > 0 && u.talent === 22290);

  let rule = (cfg && cfg.rule) || getSkillRule(cfg ? cfg.id : 0);
  if (rule && elementExclusiveOf(actor, cfg.id) && elementReplacesBase(actor, cfg.id)) rule = null;
  const effects = [];
  const phase = ((actIndex || 0) * 100) + 4; // TRIGGER_TIME_AFTER_SKILL
  const rnd = Math.random;
  // 绝对防御（10007，批次H2）：敌方技能对绝对防御目标的效果段不生效（伤害段已在 settleSkill 拦）。
  // 己方技能不受影响（t.side === actor.side 放行）；例外：10139 波动斩（穿透）、
  // 10068/10140 破坏类（"可破坏屏障和绝对防御"——必须能命中受保护目标才有破坏可言）。
  // ⚠️ 近似：走 allUnits 全员扫描的规则（如 supportBanBoth）不经 targets，会绕过本过滤。
  const absDefRound = battleState ? Number(battleState.round || 0) : 0;
  if (!(rule && (rule.pierceAbsoluteDef || rule.breakBarrier))) {
    targets = targets.filter(t => !(t && t.absoluteDef && t.absoluteDefRound === absDefRound && t.side !== actor.side));
  }
  // P3-C 指引之光（10203 专属改写·1345012）：本回合在其后使用的光系技能 → 己方全体较高攻击+1
  if (battleState && battleState.guideLightRound === battleState.round && battleState.guideLightSide === actor.side
      && Number(cfg.nature) === 5 && actor.hp > 0) {
    (allUnits || []).forEach(a => {
      if (!a || a.hp <= 0 || a.side !== actor.side) return;
      gainStat(a, (a.attrs && a.attrs.phy_atk >= a.attrs.mag_atk) ? 101 : 102, 1, { effects, srcId: 10203, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
    });
  }
  // P3 动物退散（10377）：被嘲讽目标释放单体技能 → 较高攻-2；非单体 → 随机防御-1
  if ((actor.animalRepelRounds || 0) > 0 && cfg) {
    const single = Number(cfg.effType) === 1007 || EFF_FOE_ONE.has(Number(cfg.effType));
    const hi = (actor.attrs && actor.attrs.phy_atk >= actor.attrs.mag_atk) ? 101 : 102;
    if (single) gainStat(actor, hi, -2, { effects, srcId: 10377, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    else gainStat(actor, Math.random() < 0.5 ? 103 : 104, -1, { effects, srcId: 10377, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
  }
  // 记录“谁对谁用过辅助技”（10291 风之返恩的 5 回合条件）
  if (battleState && Number(cfg.type) === 3 && isFriendEff(cfg.effType)) {
    const rd = Number(battleState.round) || 1;
    (targets || []).forEach(t => {
      if (t && t.id !== actor.id) {
        t.supportReceivedLog = t.supportReceivedLog || {};
        t.supportReceivedLog[actor.id] = rd;
      }
    });
  }
  if (!rule) return effects;

  // 1. 全体属性等级重置（如 10014 归还的极光）
  if (rule.resetStats === 'all') {
    // ⚠️ initUnitBattleState 只在 statLevels 为 undefined 时建默认表，**不会清零已有值**——
    //    原来直接调它等于什么都没重置；随后的 effect 又写死 encodeAttrVal(101, 0)，
    //    客户端只收到「物攻 0 级变化」：既报错（能力等级变化为0），属性也不会归零。
    //    正确做法：逐项把真实 oldLv 归零，并按「每目标每属性 δ = -oldLv」下发。
    (allUnits || []).forEach(u => {
      if (!u) return;
      initUnitBattleState(u);
      const lv = u.statLevels || {};
      [101, 102, 103, 104, 105, 111, 113, 115].forEach(p => {
        const oldLv = Number(lv[p]) || 0;
        if (oldLv === 0) return;
        lv[p] = 0;
        const attrName = PROP_ATTR_NAMES[p];
        if (attrName) u[attrName] = 0;
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [u.id],
          src_type: 3,
          src_id: cfg.id,
          id: PROP_FEATURE_IDS[p] || 20001,
          effect_phase: phase,
          change_type: 100000, // FIGHT_EFF_CHANGE_TYPE_ATTR
          change_value: [encodeAttrVal(p, -oldLv)],
          remove_round: 0,
        });
      });
    });
  }

  // 1b. P4 基础规则扩展（10006 嘲讽 / 10008 泉涌 / 10092·10144 随机能力 / 10110 交换 / 10002 法力屏障）
  if (rule.tauntRounds) {
    // 10006 仇恨吸引是"把对手的单体技能转移到自身" → 施加对象是全体敌方，不是技能目标
    const list = Number(cfg.id) === 10006
      ? (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side)
      : targets;
    list.forEach(t => { if (t && t.hp > 0) { t.tauntedBy = actor.id; t.tauntRounds = Math.max(t.tauntRounds || 0, rule.tauntRounds); } });
  }
  if (rule.soulPaintRounds) {
    targets.forEach(t => { if (t && t.hp > 0) t.soulPaintRounds = Math.max(t.soulPaintRounds || 0, rule.soulPaintRounds); });
  }
  if (rule.healHalfRounds || rule.randomDefDownRounds) {
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      if (rule.healHalfRounds) t.healHalfRounds = Math.max(t.healHalfRounds || 0, rule.healHalfRounds);
      if (rule.randomDefDownRounds) t.randomDefDownRounds = Math.max(t.randomDefDownRounds || 0, rule.randomDefDownRounds);
    });
  }
  if (rule.lightSword) {
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.lightSwordRounds = Math.max(t.lightSwordRounds || 0, rule.lightSword.rounds || 1);
      t.lightSwordPct = rule.lightSword.pct != null ? rule.lightSword.pct : 1.5;
    });
  }
  if (rule.roundEndAllyRandom) actor.roundEndAllyRandom = Math.max(actor.roundEndAllyRandom || 0, rule.roundEndAllyRandom);
  if (rule.roundEndStat) actor.roundEndStat = { prop: rule.roundEndStat.prop, delta: rule.roundEndStat.delta, rounds: rule.roundEndStat.rounds || 3 };
  if (rule.teamShieldPct) {
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      const shieldPct = (rule.teamShieldPctClannad && isClannad(a.type)) ? Number(rule.teamShieldPctClannad) : Number(rule.teamShieldPct);
      exclusiveAddShield(actor, a, Math.max(1, Math.round((a.maxHp || 1) * shieldPct / 100)), { effects, phase }, cfg.id);
    });
  }
  if (rule.defPierceOnHit) {
    targets.forEach(t => { if (t && t.hp > 0) t.defPierceRounds = Math.max(t.defPierceRounds || 0, rule.defPierceOnHit); });
  }
  if (rule.delayStrike) {
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      if (rule.delayStrike.stripPositive) {
        [101, 102, 103, 104, 105].forEach(p2 => { const lv = (t.statLevels && t.statLevels[p2]) || 0; if (lv > 0) gainStat(t, p2, -lv, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase }); });
      }
      actor.delayedStrike = { targetId: t.id, round: Number(battleState && battleState.round || 0) + 1, power: rule.delayStrike.power || 1, skillId: cfg.id };
    });
  }
  if (rule.talentParam) actor.talentParamOverride = { hpLine: rule.talentParam.hpLine, dmg: rule.talentParam.dmg };
  if (rule.nextOutDownByNatureCount) {
    const ns = new Set((allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).map(a => a.nature));
    const n = ns.size;
    if (n > 0) {
      targets.forEach(t => { if (t && t.hp > 0) t.nextOutDmgDown = Math.min(1, (Number(t.nextOutDmgDown) || 0) + n * rule.nextOutDownByNatureCount.pct); });
      (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side)
        .forEach(a => { a.nextOutDmgUp = (Number(a.nextOutDmgUp) || 0) + n * rule.nextOutDownByNatureCount.pct * (rule.nextOutDownByNatureCount.allyMul || 0); });
    }
  }
  if (rule.weatherIfAllStone != null) {
    const all = (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side);
    if (all.length && all.every(a => (a.skills || []).some(s => Number(s.id) === 10011)) && battleState) {
      battleState.weather = { start_weather: rule.weatherIfAllStone, weather_end_round: Number(battleState.round || 1) + 5 };
    }
  }
  if (rule.skyGiftConsume) {
    const n = Number(actor.skyGiftStacks) || 0;
    if (n > 0) { actor.nextCritBonus = (Number(actor.nextCritBonus) || 0) + n; actor.skyGiftStacks = 0; }
  }
  if (rule.stance) {
    actor.stanceRounds = rule.stance.rounds || 3;
    actor.stanceKind = rule.stance.kind;
  }
  if (rule.debuffDouble) {
    targets.forEach(t => { if (t && t.hp > 0) t.debuffDoubleRounds = Math.max(t.debuffDoubleRounds || 0, rule.debuffDouble); });
  }
  if (rule.roundEndRandomDebuff) {
    actor.roundEndRandomDebuff = Math.max(actor.roundEndRandomDebuff || 0, rule.roundEndRandomDebuff);
  }
  if (rule.randomFoeDefDown) {
    const foes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side).sort(() => Math.random() - 0.5);
    foes.slice(0, rule.randomFoeDefDown).forEach(t => gainStat(t, 103, -1, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase }));
  }
  if (rule.randomAllyAtkUp) {
    const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side).sort(() => Math.random() - 0.5);
    allies.slice(0, rule.randomAllyAtkUp).forEach(a => gainStat(a, 101, 1, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase }));
  }
  if (rule.slowCookBase) {
    actor.slowCookBaseRounds = Math.max(actor.slowCookBaseRounds || 0, rule.slowCookBase.rounds || 5);
    actor.slowCookBasePct = rule.slowCookBase.pct || 15;
  }
  if (rule.allyCampStat) {
    const ac = rule.allyCampStat;
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side && servantCamp(a.type) === Number(ac.camp)).forEach(a => {
      (ac.changes || []).forEach(ch => gainStat(a, ch.prop, ch.delta, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase }));
    });
  }
  if (rule.nightLord) {
    actor.nightLordRounds = Math.max(actor.nightLordRounds || 0, rule.nightLord);
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => { a.nightNoDrop = true; });
  }
  if (rule.nukeShell) {
    const cost = Math.max(1, Math.round((actor.maxHp || 1) * 0.20));
    actor.hp = Math.max(1, actor.hp - cost);
    // 2026-10-27：施放自损补 200000 负值（静默 60120），否则血条不动
    effects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 3, src_id: 10372, id: 60120, effect_phase: 3,
      change_type: 200000, change_value: [-cost], remove_round: 0,
    });
    actor.firstHitTo1 = true;
    actor.firstHitTo1Round = Number(battleState && battleState.round || 0) + 1;
  }
  if (rule.randomBuff) {
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      const b = [BUFF_IDS.BURN, BUFF_IDS.PARALYSIS, BUFF_IDS.POISON][Math.floor(Math.random() * 3)];
      applyExclusiveBuff(actor, t, b, 100, 3, { effects, phase });
    });
  }
  if (rule.lightBear) {
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      const before = Math.round(a.hp);
      const cost = Math.max(1, Math.round(a.hp * 0.15));
      const heal = Math.max(1, Math.round((a.maxHp || 1) * 0.03));
      a.hp = Math.max(1, a.hp - cost);
      a.hp = Math.min(a.maxHp, a.hp + heal);
      a.lightBearRounds = 3;
      // 2026-10-27：净变化补 200000（静默 60120），否则背负代价/回复不可见
      const net = Math.round(a.hp) - before;
      if (net !== 0) {
        effects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: a.id, tar_servant_ids: [a.id],
          src_type: 3, src_id: 10387, id: 60120, effect_phase: 3,
          change_type: 200000, change_value: [net], remove_round: 0,
        });
      }
    });
  }
  if (rule.sweetDreamNext) {
    targets.forEach(t => { if (t && t.hp > 0) t.sweetDreamNext = true; });
  }
  if (rule.supportBanBoth) {
    actor.supportBanRounds = Math.max(actor.supportBanRounds || 0, rule.supportBanBoth);
    (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side).forEach(u => {
      u.supportBanRounds = Math.max(u.supportBanRounds || 0, rule.supportBanBoth);
    });
  }
  if (rule.selfHpCostPct) {
    const costBefore = actor.hp;
    actor.hp = Math.max(1, actor.hp - Math.max(1, Math.round((actor.maxHp || 1) * rule.selfHpCostPct / 100)));
    // 自费 HP 必须下发（10115 恶魔的契约/10356 丰满的麦穗）——否则客户端血条停在旧值，
    // 下一次绝对同步瞬跳（苏摩 23140 同族，2026-11-01）。60120=静默承载条目（D15 口径）。
    if (actor.hp < costBefore) {
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 3, src_id: cfg.id, id: 60120, effect_phase: phase,
        change_type: 200000, change_value: [-(costBefore - actor.hp)], remove_round: 0,
      });
    }
  }
  if (rule.animalRepel) {
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.tauntedBy = actor.id;
      t.tauntRounds = Math.max(t.tauntRounds || 0, rule.tauntRounds || 3);
      t.animalRepelRounds = Math.max(t.animalRepelRounds || 0, rule.animalRepel);
    });
  }
  if (rule.clearNegativeSelf) {
    let cleared = 0;
    [101, 102, 103, 104, 105].forEach(p2 => { const lv = (actor.statLevels && actor.statLevels[p2]) || 0; if (lv < 0) { gainStat(actor, p2, -lv, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase }); cleared += -lv; } });
    if (cleared > 0 && rule.nextInDmgDownPerClear) actor.nextInDmgDown = Math.min(1, (Number(actor.nextInDmgDown) || 0) + cleared * rule.nextInDmgDownPerClear);
  }
  if (rule.clearNegativeTarget) {
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      const gain = {};
      [101, 102, 103, 104, 105].forEach(p2 => { const lv = (t.statLevels && t.statLevels[p2]) || 0; if (lv < 0) { gainStat(t, p2, -lv, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase }); gain[p2] = -lv; } });
      if (rule.teamGainCleared) {
        (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
          Object.keys(gain).forEach(k => gainStat(a, Number(k), gain[k], { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase }));
        });
      }
    });
  }
  if (rule.noKnockdown) {
    targets.forEach(t => { if (t && t.hp > 0) t.noKnockdownRounds = Math.max(t.noKnockdownRounds || 0, rule.noKnockdown); });
  }
  if (rule.clearDebuffs) {
    // 10109 痊愈之歌 / 10132 痊愈之颂咏 / 10178 新月之光：解除己方异常；
    // 10189 元气之音（攻击技）：描述只要求解除己方睡眠。WIKI 异常口径见 ABNORMAL_BUFF_IDS。
    const onlySleep = Number(cfg.type) !== 3;
    const clearList = onlySleep ? (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side) : targets;
    clearList.forEach(t => {
      if (!t || t.hp <= 0) return;
      const ids = onlySleep ? [BUFF_IDS.SLEEP] : Array.from(ABNORMAL_BUFF_IDS);
      ids.forEach(id => {
        if (t.buffs && t.buffs[id]) {
          delete t.buffs[id];
          effects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
            src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
            change_type: 300020, change_value: [id], remove_round: 0,
          });
        }
      });
      if (t.flinch) t.flinch = false;
    });
  }
  // —— 2026-11-09 P0 辅助技批次 ——
  if (rule.ascend) {
    // 10186 飞升灵药：进入飞升状态（被攻击必暴 / 提升能力等级额外 +1 级）
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.ascendRounds = Math.max(t.ascendRounds || 0, Number(rule.ascend.rounds) || 3);
      t.ascendSrcId = actor.id;
    });
  }
  if (rule.targetShieldLevelMul) {
    // 10314 熊之外套：目标获得「自身等级 × 6/8」护盾（clannad 对象系数 8）
    const m = rule.targetShieldLevelMul;
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      const k = isClannad(t.type) ? Number(m.clannad || m.base) : Number(m.base || 6);
      exclusiveAddShield(actor, t, Math.max(1, Math.round((Number(actor.level) || 1) * k)), { effects, phase }, cfg.id);
    });
  }
  if (rule.holyRedemption) {
    // 10245 圣光救赎：回复 25%HP，清除所有负面能力等级，每清除 1 级额外 +5% 回复
    const hr = rule.holyRedemption;
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      let cleared = 0;
      [101, 102, 103, 104, 105].forEach(pr => {
        const lv = (t.statLevels && t.statLevels[pr]) || 0;
        if (lv < 0) { gainStat(t, pr, -lv, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase }); cleared += -lv; }
      });
      const pct = Number(hr.healPct || 25) + Number(hr.perClearPct || 5) * cleared;
      const before = t.hp;
      const heal = Math.max(1, Math.round((t.maxHp || 1) * pct / 100 * healReceivedMul(t) * healDealtMul(actor)));
      t.hp = Math.min(t.maxHp, t.hp + heal);
      const real = Math.round(t.hp) - Math.round(before);
      if (real > 0) effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
        src_type: 3, src_id: cfg.id, id: 60120, effect_phase: phase,
        change_type: 200000, change_value: [real], remove_round: 0,
      });
    });
  }
  if (rule.pureHeart) {
    // 10353 纯洁之心：3 回合免异常 + 每回合末随机 +1 能力等级
    const rounds = Number(rule.pureHeart.rounds) || 3;
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.pureHeartRounds = Math.max(t.pureHeartRounds || 0, rounds);
      t.pureHeartSrcId = actor.id;
      t.noAbnormalRounds = Math.max(t.noAbnormalRounds || 0, rounds);
    });
  }
  if (rule.scarabShell) {
    // 10375 圣甲虫护壳：自损 30%最大生命；己方 3 回合受到伤害 -25%；免疫异常一次；
    // 若施放前己方已有减伤效果，则随机防御 +1、随机攻击 +1。
    const ss = rule.scarabShell;
    const costBefore = actor.hp;
    actor.hp = Math.max(1, actor.hp - Math.max(1, Math.round((actor.maxHp || 1) * Number(ss.hpCostPct || 30) / 100)));
    if (actor.hp < costBefore) effects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 3, src_id: cfg.id, id: 60120, effect_phase: phase,
      change_type: 200000, change_value: [-(costBefore - actor.hp)], remove_round: 0,
    });
    const allies = (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side);
    const hadMit = allies.some(a => (Number(a.nextInDmgDown) || 0) > 0 || (Number(a.phyBarrierRounds) || 0) > 0
      || (Number(a.magicBarrierRounds) || 0) > 0 || (Number(a.teamDmgDownRounds) || 0) > 0);
    allies.forEach(a => {
      a.teamDmgDownRounds = Math.max(a.teamDmgDownRounds || 0, Number(ss.rounds || 3));
      a.teamDmgDownPct = Math.max(Number(a.teamDmgDownPct) || 0, Number(ss.dmgDownPct || 25));
      a.abnormalImmuneCharges = Math.max(Number(a.abnormalImmuneCharges) || 0, Number(ss.abnormalImmuneCharges || 1));
      if (hadMit && ss.bonusIfMit) {
        gainStat(a, Math.random() < 0.5 ? 103 : 104, 1, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
        gainStat(a, Math.random() < 0.5 ? 101 : 102, 1, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
      }
    });
  }
  if (rule.devotionPact) {
    // 10391 奉献誓约：失去当前 30% 生命，防御 +1，吸引 3 次单体攻击；
    // 次数耗尽在 settleSkill 命中段消费（tauntHitsLeft），并在那里给己方全体较高攻击 +1。
    const dp = rule.devotionPact;
    const before = actor.hp;
    actor.hp = Math.max(1, actor.hp - Math.max(1, Math.round(actor.hp * Number(dp.hpCostPct || 30) / 100)));
    if (before > actor.hp) effects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 3, src_id: cfg.id, id: 60120, effect_phase: phase,
      change_type: 200000, change_value: [-(before - actor.hp)], remove_round: 0,
    });
    if (dp.defUp) {
      gainStat(actor, 103, Number(dp.defUp), { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
      gainStat(actor, 104, Number(dp.defUp), { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    }
    actor.tauntHitsLeft = Math.max(Number(actor.tauntHitsLeft) || 0, Number(dp.tauntHits || 3));
    (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side).forEach(f => {
      f.tauntedBy = actor.id;
      f.tauntRounds = 99; // 次数由 tauntHitsLeft 管理（不让回合递减提前清除）
    });
  }
  // —— 2026-11-10 P1 辅助技批次（13 个）——
  if (rule.bloodRuin) {
    // 10263 血坏：物攻等级提升至最大；之后 3 回合回合末损失递增的生命
    gainStat(actor, 101, 6, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    actor.bloodRuinRounds = Math.max(actor.bloodRuinRounds || 0, Number(rule.bloodRuin.rounds) || 3);
    actor.bloodRuinTurn = 0;
    actor.bloodRuinPerTurnPct = Number(rule.bloodRuin.perTurnPct) || 10;
    actor.bloodRuinMaxPct = Number(rule.bloodRuin.maxPct) || 30;
  }
  if (rule.selfTaunt) {
    // 10285 ORa！：本回合获得仇恨吸引；随机一项防御 +1
    (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side).forEach(f => {
      f.tauntedBy = actor.id;
      f.tauntRounds = Math.max(f.tauntRounds || 0, Number(rule.selfTaunt.rounds) || 1);
    });
    if (rule.randomDefUp) gainStat(actor, Math.random() < 0.5 ? 103 : 104, Number(rule.randomDefUp), { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
  }
  if (rule.invertNegativeTarget) {
    // 10305 善根萌长：负面能力等级转为同数值的正向等级
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      [101, 102, 103, 104, 105].forEach(pr => {
        const lv = (t.statLevels && t.statLevels[pr]) || 0;
        if (lv < 0) gainStat(t, pr, -2 * lv, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
      });
    });
  }
  if (rule.statDownImmunityRounds) {
    // 10320 注意集中：能力等级不会降低
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.statDownImmuneRounds = Math.max(t.statDownImmuneRounds || 0, Number(rule.statDownImmunityRounds) || 3);
    });
  }
  if (rule.noAbnormalRounds) {
    // 10320 注意集中：不会进入异常
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.noAbnormalRounds = Math.max(t.noAbnormalRounds || 0, Number(rule.noAbnormalRounds) || 3);
    });
  }
  if (rule.kingsGuard) {
    // 10253 王座的守护：本回合受伤 -25%，每受一次攻击较高攻 +1
    const kg = rule.kingsGuard;
    const rounds = Number(kg.rounds) || 1;
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.inDmgDownRounds = Math.max(t.inDmgDownRounds || 0, rounds);
      t.inDmgDownPct = Math.max(Number(t.inDmgDownPct) || 0, Number(kg.dmgDownPct) || 25);
      // 受击加攻窗口多保留 1 回合：避免十香慢于敌人时本回合已无后续攻击、完全看不到效果
      t.kingsGuardRounds = Math.max(t.kingsGuardRounds || 0, rounds + 1);
    });
  }
  if (rule.foresight) {
    // 10321 后见之明：若本回合该誓灵已受到过攻击，物攻/魔攻/速度 +2（优先度 -1 在 SKILL_PRIO_TABLE）
    targets.forEach(t => {
      if (!t || t.hp <= 0 || !t.hitThisRound) return;
      [101, 102, 105].forEach(pr => gainStat(t, pr, Number(rule.foresight.atkUp) || 2, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase }));
    });
  }
  if (rule.eternalRelease) {
    // 10323 永恒解脱：4 回合内伤害 ×4；到期进入解脱状态（标志在回合末维护）
    if (!actor.eternalReleased) {
      actor.eternalReleaseRounds = Math.max(actor.eternalReleaseRounds || 0, Number(rule.eternalRelease.rounds) || 4);
      actor.eternalReleaseDmgMul = Number(rule.eternalRelease.dmgMul) || 4;
      actor.eternalReleaseAtRound = (Number(battleState && battleState.round) || 1) + (Number(rule.eternalRelease.rounds) || 4);
      actor.eternalReleased = false;
    } else {
      actor.eternalReleaseRounds = 0; // 解脱后再次点 10323 不解除锁定
    }
  }
  if (rule.reflectDirect) {
    // 10399 瑶草：本回合受到的直接技能伤害反馈给攻击者
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.reflectDirectRounds = Math.max(t.reflectDirectRounds || 0, Number(rule.reflectDirect.rounds) || 1);
    });
  }
  if (rule.forgive) {
    // 10414 无上宽恕：清除自身全部能力等级；5 回合内造成伤害/暴击率 +n×10%
    let cleared = 0;
    [101, 102, 103, 104, 105, 111, 113, 115].forEach(pr => {
      const oldLv = (actor.statLevels && actor.statLevels[pr]) || 0;
      if (oldLv === 0) return;
      cleared += Math.abs(oldLv);
      gainStat(actor, pr, -oldLv, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    });
    actor.forgiveDmgRounds = Math.max(actor.forgiveDmgRounds || 0, Number(rule.forgive.rounds) || 5);
    actor.forgiveDmgPct = (Number(rule.forgive.perClearPct) || 10) / 100 * cleared;
    actor.forgiveCritPct = (Number(rule.forgive.perClearPct) || 10) / 100 * cleared;
  }
  if (rule.xuanYou) {
    // 10431 玄佑：按自身物攻对自身造成 60 威力伤害（非致死），物防魔防 +1，触发 3 次玄武天赋
    const xy = rule.xuanYou;
    const lv = Number(actor.level) || 1;
    const atkLv = (actor.statLevels && actor.statLevels[101]) || 0;
    const defLv = (actor.statLevels && actor.statLevels[103]) || 0;
    const atk = (actor.attrs.phy_atk || 100) * attrLvMul(atkLv);
    const def = (actor.attrs.phy_def || 100) * attrLvMul(defLv);
    const selfDmg = Math.max(1, Math.round(((lv + 5) / 50) * (Number(xy.power) || 60) * atk / Math.max(1, def)));
    const before = actor.hp;
    actor.hp = Math.max(1, actor.hp - selfDmg);
    if (before > actor.hp) effects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 3, src_id: cfg.id, id: 60120, effect_phase: phase,
      change_type: 200000, change_value: [-(before - actor.hp)], remove_round: 0,
    });
    if (xy.defUp) {
      gainStat(actor, 103, Number(xy.defUp), { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
      gainStat(actor, 104, Number(xy.defUp), { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    }
    const hasBaihu = (allUnits || []).some(b => b && b.hp > 0 && b.side === actor.side && b.talent === 23300);
    const inc = hasBaihu ? 0.30 : 0.20;
    for (let i = 0; i < (Number(xy.talentHits) || 3); i++) {
      (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side).forEach(ally => {
        ally.xuanwuNextBonus = (ally.xuanwuNextBonus || 0) + inc;
      });
    }
  }
  // —— 2026-11-13 P1.5 群体辅助批次（6 个）——
  if (rule.starLegacy) {
    const sl = rule.starLegacy;
    const hpPct = ((actor.hp || 0) / (actor.maxHp || 1)) * 100;
    const pct = hpPct >= (Number(sl.threshold) || 40) ? Number(sl.highPct) : Number(sl.lowPct);
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      a.teamDmgUpRounds = Math.max(a.teamDmgUpRounds || 0, Number(sl.rounds) || 2);
      a.teamDmgUpPct = Math.max(Number(a.teamDmgUpPct) || 0, pct);
    });
  }
  if (rule.freeBreath) {
    const fb = rule.freeBreath;
    const before = actor.hp;
    actor.hp = Math.max(1, actor.hp - Math.max(1, Math.round((actor.maxHp || 1) * Number(fb.hpCostPct || 15) / 100)));
    if (before > actor.hp) effects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 3, src_id: cfg.id, id: 60120, effect_phase: phase,
      change_type: 200000, change_value: [-(before - actor.hp)], remove_round: 0,
    });
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      const lo = Number(fb.minUp) || 1, hi = Number(fb.maxUp) || 2;
      let delta = lo + Math.floor(Math.random() * (hi - lo + 1));
      if (isHoloServant(a.type)) delta += Number(fb.holoExtra) || 1;
      const prop = [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)];
      gainStat(a, prop, delta, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
    });
  }
  if (rule.windGrace) {
    const wg = rule.windGrace;
    const rd = Number(battleState && battleState.round) || 1;
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      const used = Number((actor.supportReceivedLog || {})[a.id]) || 0;
      const pct = used > 0 && rd - used <= (Number(wg.window) || 5) ? Number(wg.boostedPct) : Number(wg.basePct);
      a.nextOutDmgUp = Math.max(Number(a.nextOutDmgUp) || 0, pct / 100);
    });
  }
  if (rule.treasureBanner) {
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      [101, 102, 103, 104, 105].forEach(pr => {
        const lv = (a.statLevels && a.statLevels[pr]) || 0;
        if (lv < 0) gainStat(a, pr, -lv, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
      });
      gainStat(a, Math.random() < 0.5 ? 103 : 104, 1, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
    });
  }
  if (rule.guardianSpirit) {
    const gs = rule.guardianSpirit;
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      a.teamDmgDownRounds = Math.max(a.teamDmgDownRounds || 0, Number(gs.rounds) || 1);
      a.teamDmgDownPct = Math.max(Number(a.teamDmgDownPct) || 0, Number(gs.dmgDownPct) || 35);
      a.healReceivedBoostRounds = Math.max(a.healReceivedBoostRounds || 0, Number(gs.rounds) || 1);
      a.healReceivedBoostPct = Math.max(Number(a.healReceivedBoostPct) || 0, Number(gs.healUpPct) || 20);
    });
  }
  if (rule.lifeBloom) {
    const lb = rule.lifeBloom;
    const allies = (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side);
    allies.forEach(a => {
      exclusiveAddShield(actor, a, Math.max(1, Math.round((a.maxHp || 1) * (Number(lb.shieldPct) || 10) / 100)), { effects, phase }, cfg.id);
    });
    let seeds = 0;
    allies.forEach(a => {
      const n = Number(a.lifeSeeds) || 0;
      if (n > 0) {
        seeds += n;
        a.lifeSeeds = 0;
        effects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: a.id, tar_servant_ids: [a.id],
          src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
          change_type: 300020, change_value: [22770], remove_round: 0,
        });
      }
    });
    for (let i = 0; i < seeds; i++) {
      const a = allies[Math.floor(Math.random() * allies.length)];
      const prop = [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)];
      gainStat(a, prop, 1, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: a.id, phase });
    }
  }
  if (rule.skillLock) {
    targets.forEach(t => { if (t && t.hp > 0) { t.skillLock = (t.usedSkillsThisRound || []).slice(0, 8); t.skillLockRound = Number(battleState && battleState.round || 0) + 1; } });
  }
  if (rule.judgment) {
    targets.forEach(t => {
      if (t && t.hp > 0) {
        t.judgmentRounds = rule.judgment;
        t.noPositiveRounds = rule.judgment;
        effects.push({ // 轮回判决横幅（基础版 2 回合同样宣告；一条一目标 D9）
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 22710, id: 22710, effect_phase: ((actIndex || 0) * 100) + 4,
          change_type: 200000, change_value: [0], remove_round: 0,
        });
      }
    });
  }
  if (rule.levelOverride) actor.levelOverrideBonus = rule.levelOverride;
  if (rule.talentBoth) actor.arroganceBoth = true;
  // 批次H2：「破坏屏障和绝对防御」——屏障按官方文案含力量/法力屏障（5 回合减伤），一并清
  if (rule.breakBarrier) targets.forEach(t => {
    if (t && t.hp > 0) {
      t.shield = 0; t.absoluteDef = false;
      t.phyBarrierRounds = 0; t.magicBarrierRounds = 0;
    }
  });
  if (rule.firstDmgStat && battleState && battleState.firstDmgRound === battleState.round && battleState.firstDmgActor === actor.id) {
    gainStat(actor, 101, 2, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    gainStat(actor, Math.random() < 0.5 ? 103 : 104, 2, { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
  }
  if (rule.healBanAll) {
    targets.forEach(t => { if (t && t.hp > 0) t.healBanRounds = Math.max(t.healBanRounds || 0, rule.healBanAll); });
  }
  // —— 批次H1 规则链 setter 族 ——
  if (rule.healBlockRounds) {
    // 回复封印（10005）：完全禁疗（healReceivedMul ×0），覆盖三条治疗入口（healPct/postDamageHeal/回合末）
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.healBlockRounds = Math.max(t.healBlockRounds || 0, rule.healBlockRounds);
      // 官方生效特性 10041「回复封印生效」（FightFeature.lua，tips: #tar的回复手段被封锁住了！）
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 10041, id: 10041, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    });
  }
  if (rule.supportBanTargetRounds) {
    // 激怒（10104）：目标侧禁辅（区别于 supportBanBoth 的双方全员）
    targets.forEach(t => { if (t && t.hp > 0) t.supportBanRounds = Math.max(t.supportBanRounds || 0, rule.supportBanTargetRounds); });
  }
  if (rule.teamAoeImmuneRounds) {
    // 结界盾（10004/90003）：己方全体本回合免疫群体技能伤害（消费在 settleSkill 攻击分支）
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      a.aoeImmuneRounds = Math.max(a.aoeImmuneRounds || 0, rule.teamAoeImmuneRounds);
    });
    // 官方生效特性 10031「结界盾生效」（tips: 己方场地上出现了结界盾！）
    effects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 1, src_id: 10031, id: 10031, effect_phase: phase,
      change_type: 0, change_value: [], remove_round: 0,
    });
  }
  if (rule.teamSpeedMulRounds) {
    // 疾走之风（10009）：己方全体速度翻倍（effectiveSpeed 消费）
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      a.teamSpeedMulRounds = Math.max(a.teamSpeedMulRounds || 0, rule.teamSpeedMulRounds);
    });
    // 官方生效特性 10081「疾走之风生效」（tips: 风精灵在己方场地唤起了疾走之风）
    effects.push({
      trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
      src_type: 1, src_id: 10081, id: 10081, effect_phase: phase,
      change_type: 0, change_value: [], remove_round: 0,
    });
  }
  if (rule.absoluteDef) {
    // 绝对防御（10007，批次H2）：本回合免疫敌方技能（伤害在 settleSkill 拦、效果在函数顶部拦）。
    // 「连续使用容易失败」：官方无数值 → Protect 式近似（连续第2次 50% 失败、第3次 25%……）。
    const rNow = battleState ? Number(battleState.round || 0) : 0;
    const streak = (rNow === (Number(actor.absoluteDefLastRound) || 0) + 1) ? (Number(actor.absoluteDefStreak) || 0) + 1 : 1;
    actor.absoluteDefStreak = streak;
    actor.absoluteDefLastRound = rNow;
    const failChance = streak >= 2 ? Math.pow(0.5, streak - 1) : 0;
    if (rnd() < failChance) {
      // 连续使用失败：本回合无保护（无生效特性事件，客户端只看到技能空放）
    } else {
      actor.absoluteDef = true;
      actor.absoluteDefRound = rNow;
      // 官方生效特性 10051「绝对防御生效」（tips: #src进入了绝对防御状态）
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 1, src_id: 10051, id: 10051, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    }
  }
  // —— 批次H3 回合状态机 setter 族 ——
  if (rule.mindShackle) {
    // 心灵暗示（10003）：目标接下来 3 次只能使用"最后使用的技能"（从未用过 → 不设限）
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      if (t.lastUsedSkill != null) {
        t.mindShackleCount = Math.max(t.mindShackleCount || 0, rule.mindShackle);
        t.mindShackleSkillId = t.lastUsedSkill;
        // 官方生效特性 10021「心灵暗示生效」（tips: #tar被施加了心灵暗示）
        effects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
          src_type: 1, src_id: 10021, id: 10021, effect_phase: phase,
          change_type: 0, change_value: [], remove_round: 0,
        });
      }
    });
  }
  if (rule.sealRelic) {
    // 圣器封印（10116）：目标本场战斗失去圣器——一次性删除全部 relic* 字段（单位按战斗重建，
    // 无需恢复路径）；relicSealed 同时挡圣器共享（applyRelicSharing）重挂。生效特性 10801。
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      Object.keys(t).forEach(k => { if (/^relic/.test(k) || /Relic/.test(k)) delete t[k]; });
      t.relicSealed = true;
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [t.id],
        src_type: 1, src_id: 10801, id: 10801, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    });
  }
  if (rule.nextSureHitVsTarget) {
    // 狩猎标记（10015）：施放者下回合对该目标必定命中（命中段消费，round 门控自过期）
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      actor.nextSureHitVs = { targetId: t.id, round: (battleState ? Number(battleState.round || 0) : 0) + 1 };
    });
  }
  if (rule.noAttackRounds) {
    // 天击（10261）：攻击者下一回合无法使用攻击技能（aiChoose/手动路径消费，回合末递减）
    actor.noAttackRounds = Math.max(actor.noAttackRounds || 0, rule.noAttackRounds);
  }
  if (rule.roundEndSelfStatUp) {
    // 全局推演（10259）：一回合准备后，于下一回合结束使用者全部能力等级 +delta（延时类）
    actor.globalDeductionAt = (battleState ? Number(battleState.round || 0) : 0) + (rule.roundEndSelfStatUp.delay || 1);
  }
  if (rule.fusionSelf) {
    // 元素融合（10173）：同属性修正在 same 段、克制增伤在乘区段；官方无持续回合描述 → 持续到战斗结束
    actor.fusionActive = true;
  }
  if (rule.nextOutDmgUpChoices) {
    // 欧气传输（10197）：四选一随机，nextOutDmgUp 一次性消耗（乘区段）
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      const pick = rule.nextOutDmgUpChoices[Math.floor(rnd() * rule.nextOutDmgUpChoices.length)];
      t.nextOutDmgUp = (Number(t.nextOutDmgUp) || 0) + pick;
    });
  }
  if (rule.nextOutDmgUpByNegStat) {
    // 正义之星（10224）：下次伤害+50%；目标能力等级总和为负时每负 1 级额外 +50%
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      const sum = [101, 102, 103, 104, 105].reduce((s2, p2) => s2 + ((t.statLevels && t.statLevels[p2]) || 0), 0);
      const extra = Math.max(0, -sum) * (rule.nextOutDmgUpByNegStat.perLevel || 0);
      t.nextOutDmgUp = (Number(t.nextOutDmgUp) || 0) + rule.nextOutDmgUpByNegStat.base + extra;
    });
  }
  if (rule.nextOutDmgUp) {
    // 风子参上（10317）：目标下次伤害+70%（「立刻行动」部分留 H3，见规则表注释）
    targets.forEach(t => { if (t && t.hp > 0) t.nextOutDmgUp = (Number(t.nextOutDmgUp) || 0) + rule.nextOutDmgUp; });
  }
  if (rule.nextAttackCritLock) {
    // 神明启示（10244）：目标获得下次攻击必暴+爆伤提升+目标锁（settleSkill 顶部装填消费）
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.nextAttackForceCrit = true;
      t.nextAttackCritDmgUp = Math.max(Number(t.nextAttackCritDmgUp) || 0, rule.nextAttackCritLock.critDmgUp || 0.35);
      t.skillTargetLocked = true;
    });
  }
  if (rule.exciteSpring) {
    // 兴奋的秘泉（10168，2026-11-08 实现）：目标速度/伤害翻倍 + 每回合末损失最大生命 20%，持续 3 回合。
    // 速度乘区在 effectiveSpeed、伤害乘区在 settleSkill；扣血/递减/到期在 settleRoundEndTicks。
    // 客户端表现：回合末扣血发 id=11501（FightFeature「兴奋的秘泉」tips 写明 20% 生命），
    //               到期发 id=11502「兴奋的秘泉消失」。
    const es = rule.exciteSpring;
    const rounds = Number(es.rounds) || 3;
    targets.forEach(t => {
      if (!t || t.hp <= 0) return;
      t.exciteSpringRounds = Math.max(Number(t.exciteSpringRounds) || 0, rounds);
      t.exciteSpringHpLossPct = Number(es.hpLossPct) || 20;
      t.exciteSpringDmgMul = Number(es.dmgMul) || 2;
      t.exciteSpringSpeedMul = Number(es.speedMul) || 2;
      t.exciteSpringSrcId = actor.id;
    });
  }
  if (rule.noPositiveTargetRounds) {
    // 囚世地牢（10415）：目标当前回合无法提升能力等级（gainStat 内 noPositiveRounds 消费）
    targets.forEach(t => { if (t && t.hp > 0) t.noPositiveRounds = Math.max(t.noPositiveRounds || 0, rule.noPositiveTargetRounds); });
  }
  if (rule.lowHpAllyInDmgDown) {
    // 罪孽判决（10425）：己方生命<50% 的角色下次受到的技能伤害减少30%（nextInDmgDown 一次性消耗）
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side && a.hp < a.maxHp * 0.5).forEach(a => {
      a.nextInDmgDown = Math.min(1, (Number(a.nextInDmgDown) || 0) + rule.lowHpAllyInDmgDown);
    });
  }
  if (rule.selfInDmgUp) {
    // 舍命奋进（10398）：自身本回合受到伤害提升（通用 inDmgUpRounds 通道，乘区段受方立场消费）
    actor.inDmgUpRounds = Math.max(actor.inDmgUpRounds || 0, rule.selfInDmgUp.rounds || 1);
    actor.inDmgUpPct = Math.max(Number(actor.inDmgUpPct) || 0, rule.selfInDmgUp.pct || 0);
  }
  if (rule.teamImmuneCritRounds) {
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      a.immuneCrit = true;
      a.immuneCritRounds = Math.max(a.immuneCritRounds || 0, rule.teamImmuneCritRounds);
    });
  }
  if (rule.skipNextActionUnlessWeather != null && Number(battleState && battleState.weather && battleState.weather.start_weather) !== Number(rule.skipNextActionUnlessWeather)) {
    actor.skipNextAction = true;
  }
  if (rule.springRounds) {
    targets.forEach(t => { if (t && t.hp > 0) t.springRounds = Math.max(t.springRounds || 0, rule.springRounds); });
  }
  // 英勇之心（20280）：攻击类技能的"正面追加效果"全部消失（威力已在乘区补 +50%）
  // 判据：攻击技（type 1/2）+ 施术者有该天赋 → 跳过正向 statChanges / 增益 buff / 正向 randomStat
  const suppressPositive = (rule.type !== 3) && (actor.talent === 20280);

  if (rule.randomStat) {
    if (suppressPositive && Number(rule.randomStat.delta) > 0) {
      // 正向随机能力提升被吞
    } else {
    const rs = rule.randomStat;
    const affected = rs.target === 'target' ? targets
      : (rs.target === 'ally' ? (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side) : [actor]);
    const props = [101, 102, 103, 104, 105];
    affected.forEach(t => {
      if (!t || t.hp <= 0) return;
      if (rs.nature != null && Number(t.nature) !== Number(rs.nature)) return;
      if (rs.camp != null && servantCamp(t.type) !== Number(rs.camp)) return;
      if (rs.notCamp != null && servantCamp(t.type) === Number(rs.notCamp)) return;
      // 成熟的玉米 10287 等概率型：「50%随机降低敌方一项能力等级」——按目标掷概率
      if (rs.chance != null && rnd() * 100 > Math.min(100, Number(rs.chance) * skillChanceMul(actor))) return;
      for (let i = 0; i < (rs.count || 1); i++) {
        gainStat(t, props[Math.floor(rnd() * props.length)], rs.delta != null ? rs.delta : 1,
          { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t.id, phase });
      }
    });
    }
  }
  if (rule.swapStats) {
    const t0 = targets && targets[0];
    if (t0 && t0.hp > 0) {
      const props = [101, 102, 103, 104, 105];
      const av = props.map(p => (actor.statLevels && actor.statLevels[p]) || 0);
      const tv = props.map(p => (t0.statLevels && t0.statLevels[p]) || 0);
      props.forEach((p, i) => {
        if (av[i] !== tv[i]) {
          gainStat(actor, p, tv[i] - av[i], { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
          gainStat(t0, p, av[i] - tv[i], { effects, srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: t0.id, phase });
        }
      });
    }
  }
  if (rule.magicBarrier) {
    const mb = rule.magicBarrier;
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      a.magicBarrierRounds = mb.rounds || 5;
      a.magicBarrierMul = mb.mul != null ? mb.mul : 0.5;
    });
  }
  // 力量屏障（10001）：物理版屏障，与法力屏障（10002 magicBarrier）同构、消费在 cfg.type===1
  if (rule.phyBarrier) {
    const pb = rule.phyBarrier;
    (allUnits || []).filter(a => a && a.hp > 0 && a.side === actor.side).forEach(a => {
      a.phyBarrierRounds = pb.rounds || 5;
      a.phyBarrierMul = pb.mul != null ? pb.mul : 0.5;
    });
  }

  // 2. 属性等级变化（Stat Changes）
  if (rule.statChanges && Array.isArray(rule.statChanges)) {
    rule.statChanges.forEach(sc => {
      const isSelf = sc.target === 'self';
      const affected = isSelf ? [actor] : targets;
      affected.forEach(tar => {
        if (!tar || tar.hp <= 0) return;
        // 欲望激发（10251）等：prop:'higherAtk' 按目标自身 attrs 动态解析较高一项攻击（批次H1）
        const prop = (sc.prop === 'higherAtk')
          ? (((tar.attrs && tar.attrs.phy_atk) >= (tar.attrs && tar.attrs.mag_atk)) ? 101 : 102)
          : sc.prop;
        // ⚠️ 技术债收敛（2026-10-26）：原实现在此**直写 statLevels**，把免疫/钳制/事件/反转
        //    全部自己实现了一遍，与 gainStat 形成两条平行路径（任何全局语义都要挂两次）。
        //    现改为：本段只保留"规则专属的前置筛选"（camp/notCamp/概率/英勇之心），
        //    免疫、debuffDouble、反转、±6 钳制、事件推送统一交给 gainStat。
        if (suppressPositive && Number(sc.delta) > 0) return; // 20280 英勇之心：正面追加消失
        if (sc.camp != null && servantCamp(tar.type) !== Number(sc.camp)) return;
        if (sc.notCamp != null && servantCamp(tar.type) === Number(sc.notCamp)) return;
        // 10274 空间箭：满虚空下使用才降防（spaceArrowFullCast 在 settleSkill 顶部按施放前虚空快照，
        // 非 10274 施放一律复位 false——与 voidBurstSnapshot 同款防残留口径）
        if (sc.requireVoidFullCast && !actor.spaceArrowFullCast) return;
        const chance = Math.min(100, (sc.chance != null ? sc.chance : 100) * skillChanceMul(actor));
        if (rnd() * 100 > chance) return;
        let delta = sc.delta;
        // 后土（22670 土正）：在场时，己方土系誓灵不会受到等级下降的影响
        if (delta < 0 && natureOf(tar.type) === 4 && (allUnits || []).some(u => u && u.hp > 0 && u.side === tar.side && u.talent === 22670)) {
          delta = 0;
        }
        // 大吉祥天（22270 宝莲）：提升能力等级时额外提升 1 级
        if (delta > 0 && tar.lotusBlessed) {
          delta += 1;
        }
        if (delta === 0) return;
        // 统一出口：免疫（statDownImmune/shieldImmune/defLock/noPositive）、debuffDouble、
        // 反转（20200）、±6 钳制、100000 事件，全部在 gainStat 内一处生效。
        // src_type 保持 3（技能规则来源），与既有客户端展示口径一致。
        const realDelta = gainStat(tar, prop, delta, {
          effects,
          srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase,
        });
        if (realDelta === 0) return;

        // 维德佛尔尼尔（20740 智慧的注视者）：敌方通过技能提升能力等级时，天赋持有者获得同样的能力等级提升
        if (realDelta > 0) {
          (allUnits || []).forEach(watcher => {
            if (watcher && watcher.hp > 0 && watcher.side !== tar.side && watcher.talent === 20740) {
              watcher.statLevels = watcher.statLevels || {};
              const wOld = watcher.statLevels[prop] || 0;
              const wNew = Math.min(6, wOld + realDelta);
              const wDelta = wNew - wOld;
              watcher.statLevels[prop] = wNew;
              const wName = PROP_ATTR_NAMES[prop];
              if (wName) watcher[wName] = wNew;
              if (wDelta > 0) {
                effects.push({
                  trigger_count: 0,
                  atk_servant_id: actor.id,
                  src_servant_id: watcher.id,
                  tar_servant_ids: [watcher.id],
                  src_type: 1,
                  src_id: 20740,
                  id: PROP_FEATURE_IDS[prop] || 20001,
                  effect_phase: phase,
                  change_type: 100000,
                  change_value: [encodeAttrVal(prop, wDelta, wNew)],
                  remove_round: 0,
                });
              }
            }
          });
        }

        // 华胥（21270 九霄的传承）：自身能力等级提升时，己方其余九霄誓灵可获得相同的提升
        if (tar.talent === 21270 && realDelta > 0) {
          (allUnits || []).forEach(jx => {
            if (jx && jx.hp > 0 && jx.side === tar.side && jx.id !== tar.id && isJiuxiao(jx.type)) {
              jx.statLevels = jx.statLevels || {};
              const jOld = jx.statLevels[prop] || 0;
              const jNew = Math.min(6, jOld + realDelta);
              const jDelta = jNew - jOld;
              jx.statLevels[prop] = jNew;
              const jName = PROP_ATTR_NAMES[prop];
              if (jName) jx[jName] = jNew;
              if (jDelta > 0) {
                effects.push({
                  trigger_count: 0,
                  atk_servant_id: actor.id,
                  src_servant_id: tar.id,
                  tar_servant_ids: [jx.id],
                  src_type: 1,
                  src_id: 21270,
                  id: PROP_FEATURE_IDS[prop] || 20001,
                  effect_phase: phase,
                  change_type: 100000,
                  change_value: [encodeAttrVal(prop, jDelta, jNew)],
                  remove_round: 0,
                });
              }
            }
          });
        }

        // 藤林杏（22330 曲折心意）：自身能力等级下降时提升相应数量随机能力；上升时获得 10% 最大生命护盾
        if (tar.talent === 22330) {
          if (realDelta < 0) {
            const props = [101, 102, 103, 104, 105, 111, 113, 115].filter(p => p !== prop);
            const kyouGains = [];
            for (let i = 0; i < Math.abs(realDelta); i++) {
              const p = props[Math.floor(rnd() * props.length)];
              const oLv = tar.statLevels[p] || 0;
              const nLv = Math.max(-6, Math.min(6, oLv + 1));
              tar.statLevels[p] = nLv;
              const aN = PROP_ATTR_NAMES[p];
              if (aN) tar[aN] = nLv;
              if (nLv - oLv > 0) kyouGains.push(encodeAttrVal(p, nLv - oLv, nLv));
            }
            if (kyouGains.length) {
              effects.push({
                trigger_count: 0,
                atk_servant_id: actor.id /* 修复：按 curEffData.atk_id 查桶 */,
                src_servant_id: tar.id,
                tar_servant_ids: [tar.id],
                src_type: 1,
                src_id: 22330,
                id: 22330,
                effect_phase: phase,
                change_type: 100000,
                change_value: kyouGains,
                remove_round: 0,
              });
            }
          } else if (realDelta > 0) {
            const shieldAdd = Math.round(tar.maxHp * 0.10);
            tar.shield = Math.min(tar.maxHp, (tar.shield || 0) + shieldAdd);
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id /* 修复：按 curEffData.atk_id 查桶 */,
              src_servant_id: tar.id,
              tar_servant_ids: [tar.id],
              src_type: 1,
              src_id: 22330,
              id: 22330,
              effect_phase: phase,
              change_type: 200001, // SHIELD
              change_value: [shieldAdd],
              remove_round: 0,
            });
          }
        }
      });
    });
  }

  // 2b. 爱知给予（10302）「将自身能力等级覆盖敌方」（二百六十七 §8 同族 P1，2026-11-07）：
  // 按施放者当前各能力等级逐项覆盖目标（delta = 施放者 − 目标，逐项非零才动）。
  // 走 gainStat 统一出口（免疫/反转/±6 钳制/100000 展示事件一处生效）；8 项属性面含会心 111——
  // 客户端血条图标表无 111，该项只动数值不显图标（二百六十六口径）。
  if (rule.statLevelCopy) {
    const COPY_PROPS = [101, 102, 103, 104, 105, 111, 113, 115];
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0) return;
      for (const p of COPY_PROPS) {
        const delta = ((actor.statLevels && actor.statLevels[p]) || 0)
          - ((tar.statLevels && tar.statLevels[p]) || 0);
        if (delta === 0) continue;
        gainStat(tar, p, delta, {
          effects,
          srcId: cfg.id, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase,
        });
      }
    });
  }

  // 3. 异常状态应用（Buffs）
  if (rule.buffs && Array.isArray(rule.buffs)) {
    rule.buffs.forEach(b => {
      const isSelf = b.target === 'self';
      let affected = isSelf ? [actor] : targets;
      // 10274 空间箭：幻梦战时禁锢改为敌方全体（desc 括号「幻梦战时为敌方全体添加时空禁锢效果」；
      // 伤害本体仍按 handler 展开的目标集结算，这里只扩 buff 面）
      if (b.dreamAll && battleState && battleState.isDream) {
        affected = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
      }
      affected.forEach(tar => {
        if (!tar || tar.hp <= 0) return;
        // 有条件施加（10273 虚无爆发）：只有"满虚空"才混乱。
        // 快照在 settleSkill 顶部取的（此时 actor.void_energy 已被倾泻清空），必须带 cfg.id 判据，
        // 否则连击/追击等复用 applySkillEffects 的路径会读到上一次技能残留的快照。
        if (b.requireVoidFull
            && !(Number(cfg.id) === 10273 && Number(actor.voidBurstSnapshot) >= 100)) return;
        // 10327 黄印执掌：desc「若目标存在黄印标记，则消除目标的黄印标记并使其进入混乱状态」
        //（二百六十七 §8 同族 P0，2026-11-07：旧实现无条件 100% 混乱且从不消印）。
        // 无印目标直接跳过；命中后消费黄印（印源=哈斯塔 22440 回合开始上印）。
        if (b.requireYellowSign && !tar.yellowSign) return;
        // 10302 爱知给予：desc「当能力等级总和大于等于1时，使敌方陷入中毒状态」——
        // 施放者 8 项能力等级总和不足则跳过异常施加（"覆盖能力等级"本体在上方 statLevelCopy 段）。
        if (b.requireStatSum != null) {
          const statLvSum = [101, 102, 103, 104, 105, 111, 113, 115]
            .reduce((s2, p) => s2 + ((actor.statLevels && actor.statLevels[p]) || 0), 0);
          if (statLvSum < Number(b.requireStatSum)) return;
        }
        // 帕西瓦尔（23200 三城之力）：免疫与己方场地角色同属性敌方角色给予的中毒/烧伤/冰冻/睡眠/混乱
        if (tar.talent === 23200 && [1, 2, 3, 5, 6].includes(b.buffId)) {
          const sameNatFoe = (allUnits || []).some(u => u && u.hp > 0 && u.side !== tar.side &&
            (allUnits || []).some(a => a && a.hp > 0 && a.side === tar.side && a.nature === u.nature));
          if (sameNatFoe) return;
        }

        // 74. 塞勒涅（21230 不寐之月）：自身不会进入睡眠状态
        if (tar.talent === 21230 && b.buffId === BUFF_IDS.SLEEP) return;

        // 81. 修普诺斯（22500 梦境破碎）：自身免疫睡眠外的强制打断（保持自由行动）
        if (tar.talent === 22500 && b.buffId === BUFF_IDS.SLEEP) return;

        // 独角兽（23020 纯洁之兽）：本场战斗内每名己方誓灵可清除/免疫一次异常状态
        if (tar.unicornPurifyAvailable) {
          tar.unicornPurifyAvailable = false;
          return;
        }

        // 英勇之心（20280）：正面追加效果（增益类 buff）消失
        if (suppressPositive && b.buffId >= 10690 && b.buffId < 50000) return;

        // 阿佛洛狄忒（22530 美神显现）：天赋持有者免疫任何异常状态
        if (tar.talent === 22530) return;

        // 芬芳之守护（20970）/ 10353：窗口内免异常（不消耗次数）
        if (abnormalWindowBlocked(tar, b.buffId)) return;

        // 正体不明（21410 鵺）：不会进入异常状态
        if (tar.talent === 21410 && ABNORMAL_BUFF_IDS.has(Number(b.buffId))) return;

        // 睡美人（23220 沉睡魔咒）：沉睡状态下免疫1级异常状态
        if (tar.talent === 23220 && (tar.sleepCurseRounds > 0 || (tar.buffs && tar.buffs[BUFF_IDS.SLEEP]))) return;

        // 玛纳诺（22160 碧蓝海之霖）：暴雨天气下己方全员免疫异常状态
        const curW = (battleState && battleState.weather && battleState.weather.start_weather) ||
                     (actor && actor.battleState && actor.battleState.weather && actor.battleState.weather.start_weather) || 0;
        const hasManannan = (allUnits || []).some(u => u && u.hp > 0 && u.side === tar.side && u.talent === 22160);
        if (curW === WEATHER_IDS.RAIN && hasManannan) return;

        // 判决目标（10359 生死审判）不获增益：正面 buff 黑名单（与 applyExclusiveBuff 同口径）
        if ((tar.noPositiveRounds || 0) > 0 && POSITIVE_BUFF_IDS.has(b.buffId)) return;

        const chance = Math.min(100, (b.chance != null ? b.chance : 100) * skillChanceMul(actor));
        if (rnd() * 100 > chance) return;
        if (abnormalBlocked(tar, b.buffId)) return; // 10375：免疫异常一次（概率命中才消耗）
        tar.buffs = tar.buffs || {};
        const featInfo = BUFF_FEATURE_IDS[b.buffId] || { apply: 90001 };
        tar.buffs[b.buffId] = {
          level: 1,
          duration: b.duration || 3,
        };
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [tar.id],
          src_type: 3,
          src_id: cfg.id,
          id: featInfo.apply,
          effect_phase: phase,
          change_type: 300019, // FIGHT_EFF_CHANGE_TYPE_ADD_BUFF
          change_value: [encodeBuffVal(b.buffId, 1)],
          remove_round: b.duration || 3,
        });
        if (b.requireYellowSign) tar.yellowSign = false; // 消印（desc：消除目标的黄印标记）
      });
    });
  }

  // 3b. 概率畏惧（批次B 二百五十一）：炎王之拳/气刃斩/岩锥/邪神之爪——「N%几率使目标畏惧」。
  // 畏惧不是 buff（flinch 标记回合末重置），走 20630 破天轰雷同款施加通道（id 90501 提示）。
  // ⚠️ src_type 必须是 3（技能源）：5 个触发技（10034/10053/10056/10079/10288）都不在客户端
  //    FightFeature 表里，src_type=1 时 showFeature:97 会 `GetFeature(src_id, true)` → printError
  //    「不存在的特性ID：10034」等。改 3 后第二参 false ⇒ 返回 nil 不报错；
  //    提示本身走 effect.id=90501（表内、带 tips「畏惧触发」），飘字一点不变。
  if (rule.chanceFlinch && Number(rule.chanceFlinch) > 0) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0 || tar.flinch) return;
      if (rnd() * 100 < Math.min(100, Number(rule.chanceFlinch) * skillChanceMul(actor))) {
        if (flinchBlocked(tar)) return;
        applyFlinch(tar, effects, phase, cfg.id, actor.id);
        effects.push({
          trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
          src_type: 3, src_id: cfg.id, id: 90501, effect_phase: phase,
          // change_value:[0]：空值条目会被 sanitizeEffectTargets 清 tar（三百·续不变量），而
          // 90501 tips「#tar因为畏惧无法行动！」依赖目标 ⇒ 必须带非空值保住 tar。
          // ct=0 客户端无算术分支、tips 不含 #value，补 0 无任何表现差异（三百一十三）。
          change_type: 0, change_value: [0], remove_round: 0,
        });
      }
    });
  }

  // 战鼓之音（10195）/ 精灵之音（10187，批次H1）：目标下次声音技能伤害提升；
  // 10195 另提升 2 级优先度（applySkillPriorities 消费），10187 另带 ignoreDefLvUp（defLv 段消费）
  if (rule.nextSoundBoost) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0) return;
      tar.nextSoundBoost = {
        dmg: rule.nextSoundBoost.dmg || 0.20,
        prio: rule.nextSoundBoost.prio || 0,
        ignoreDefLvUp: !!rule.nextSoundBoost.ignoreDefLvUp,
      };
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
        src_type: 1, src_id: cfg.id, id: cfg.id, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    });
  }

  // 连续飞踢（10313）：造成伤害后为目标添加浮空状态一回合
  if (cfg.id === 10313) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0) return;
      tar.floatRounds = 1;
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
        src_type: 1, src_id: 10313, id: 10313, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    });
  }
  // 凝视（10269）：使目标进入凝视状态2回合，期间不能使用进入前的最后招式
  if (cfg.id === 10269) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0) return;
      tar.gazeSkillId = tar.lastUsedSkillId || tar.recordingSkillId || null;
      tar.gazeRounds = 2;
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
        src_type: 1, src_id: 10269, id: 10269, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    });
  }
  // 八上的诅咒（10350）：添加 2 层哀叹 + 阻止下回合能力提升（3 回合一次）
  if (cfg.id === 10350) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0 || (tar.lamentDeferRounds || 0) > 0) return;
      tar.lamentStacks = (tar.lamentStacks || 0) + 2;
      tar.noPositiveRounds = Math.max(tar.noPositiveRounds || 0, 1);
      tar.lamentDeferRounds = 3;
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
        src_type: 1, src_id: 10350, id: 10350, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    });
  }
  // 裁决（10394）：目标有法典 → 较高攻-1；否则较低攻+1
  if (cfg.id === 10394) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0) return;
      const hasCodex = !!tar.forsetiCodexActive;
      const prop = hasCodex
        ? (((tar.attrs && tar.attrs.phy_atk) >= (tar.attrs && tar.attrs.mag_atk)) ? 101 : 102)
        : (((tar.attrs && tar.attrs.phy_atk) <= (tar.attrs && tar.attrs.mag_atk)) ? 101 : 102);
      gainStat(tar, prop, hasCodex ? -1 : 1, { effects, srcId: 10394, srcType: 3, atkId: actor.id, srcServantId: tar.id, phase });
    });
  }
  // 捣药（10390）：消耗目标的长生药，全部能力等级+2 且 3 回合不可降（纯辅助技 → 只能在规则口生效）
  if (cfg.id === 10390) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0 || tar.lifePillUsed) return;
      tar.lifePillUsed = true;
      [101, 102, 103, 104, 105].forEach(pp => {
        gainStat(tar, pp, 2, { effects, srcId: 10390, atkId: actor.id, srcServantId: tar.id, phase });
      });
      tar.statDownImmuneRounds = Math.max(tar.statDownImmuneRounds || 0, 3);
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
        src_type: 1, src_id: 10390, id: 10390, effect_phase: phase,
        change_type: 0, change_value: [], remove_round: 0,
      });
    });
  }
  // 海星狂热（10318）：目标进入海星狂热状态（挂 2 颗海星，动作前消耗全部转增伤）
  // 三百一十三：挂星同步下发（CfgBuff[22340]「N颗海星」逐级 icon；原 change_type:0 客户端零消费）
  if (cfg.id === 10318) {
    targets.forEach(tar => {
      if (!tar || tar.hp <= 0) return;
      tar.starfishFrenzy = true;
      tar.starfish = Math.min(4, (tar.starfish || 0) + 2);
      effects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [tar.id],
        src_type: 1, src_id: 10318, id: 10318, effect_phase: phase,
        change_type: 300019, change_value: [encodeBuffVal(22340, tar.starfish)], remove_round: 0,
      });
    });
  }

  // 4. 伊吹风子（22340 最终海星使）：对友方使用辅助技能时赋予 2 个海星标记（最多 4 个）
  if (actor.talent === 22340 && (cfg.type === 3 || isFriendEff(cfg.effType))) {
    targets.forEach(tar => {
      if (tar && tar.hp > 0 && tar.side === actor.side && tar.id !== actor.id) {
        tar.starfish = Math.min(4, (tar.starfish || 0) + 2);
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 22340,
          id: 22340,
          effect_phase: phase,
          // 三百一十三：原 change_type:0 + 裸计数（客户端零消费）→ ADD_BUFF 正式编码
          change_type: 300019,
          change_value: [encodeBuffVal(22340, tar.starfish)],
          remove_round: 0,
        });
      }
    });
  }

  // 出口统一展开（客户端按目标下标消费 change_value，见 splitEffectByTarget 注释）
  return flattenEffects(effects);
}

// 检查单位行动前异常状态（睡眠、冻结、麻痹、混乱）
function checkUnitCanAct(actor, units, actIndex) {
  const buffs = actor.buffs || {};
  const phase = ((actIndex || 0) * 100) + 4;
  // 三百一十三：行动前发生的状态表现（海星狂热消耗归零的 300020）——必须并入**每一条**返回路径
  // 的 effects（dream/tower 原来只在失败路径消费 actCheck.effects，map_fight 无条件消费——
  // 已把 dream/tower 收齐为无条件消费，见 dream.js / tower_fight.js 同日改动）。
  const preEffects = [];

  // 海星狂热（10318）：目标下次使用任意技能前消耗全部海星，每消耗1个伤害提升30%（挂一次性增伤）
  if (actor.starfishFrenzy) {
    actor.starfishFrenzy = false;
    const n = Number(actor.starfish) || 0;
    actor.starfish = 0;
    if (n > 0) {
      actor.nextOutDmgUp = (Number(actor.nextOutDmgUp) || 0) + 0.30 * n;
      // 三百一十三：海星归零 → 300020 摘图标（CfgBuff[22340]「N颗海星」逐级显示此前从不下发）
      preEffects.push({
        trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [actor.id],
        src_type: 1, src_id: 60120, id: 60120, effect_phase: phase,
        change_type: 300020, change_value: [22340], remove_round: 0,
      });
    }
  }

  // P3-B 巨神的豪腕（10128 专属改写）：下回合无法行动（消耗制）
  if (actor.skipNextAction) {
    actor.skipNextAction = false;
    return { canAct: false, reason: 'skip_next', effects: [...preEffects] };
  }

    // 诺登斯（22460 梦境狩猎者）：处于深层睡眠状态跳过当前行动
  if ((actor.deepSleepRounds || 0) > 0) {
    return {
      canAct: false,
      reason: 'deep_sleep',
      effects: [...preEffects, {
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 22460,
        id: 22460,
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      }],
    };
  }

  // 石化状态（加塔诺托亚 22450 无法直视者造成）：跳过当前行动
  if (actor.petrified) {
    return {
      canAct: false,
      reason: 'petrified',
      effects: [...preEffects, {
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1, // FIGHT_EFF_FEATURE
        src_id: 22450,
        id: 922401, // 石化生效 tips: "#tar被石化了！"
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      }],
    };
  }

  // 畏惧状态（托尔破天轰雷等造成）跳过当前行动
  if (actor.flinch) {
    actor.flinch = false;
    return {
      canAct: false,
      reason: 'flinch',
      effects: [...preEffects, {
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: 90501,
        id: 90501,
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      }],
    };
  }

  // 睡眠状态跳过回合（爱丽丝 22750 与 睡美人 23220 沉睡魔咒：处于睡眠状态时依然能够正常行动）
  if (buffs[BUFF_IDS.SLEEP] && actor.talent !== 22750 && actor.talent !== 23220 && !actor.sleepCurseRounds) {
    return {
      canAct: false,
      reason: 'sleep',
      effects: [...preEffects, {
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].trigger,
        id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].trigger,
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      }],
    };
  }

  // 冻结状态跳过回合
  if (buffs[BUFF_IDS.FREEZE]) {
    return {
      canAct: false,
      reason: 'freeze',
      effects: [...preEffects, {
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: BUFF_FEATURE_IDS[BUFF_IDS.FREEZE].trigger,
        id: BUFF_FEATURE_IDS[BUFF_IDS.FREEZE].trigger,
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      }],
    };
  }

  // 麻痹状态 25% 概率跳过回合
  if (buffs[BUFF_IDS.PARALYSIS] && Math.random() < 0.25) {
    return {
      canAct: false,
      reason: 'paralysis',
      effects: [...preEffects, {
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: BUFF_FEATURE_IDS[BUFF_IDS.PARALYSIS].trigger,
        id: BUFF_FEATURE_IDS[BUFF_IDS.PARALYSIS].trigger, // 90002
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      }],
    };
  }

  // P3-A 灵魂画手（10376 专属改写·3441001）：20% 无法行动；成功行动自损随机 3 项 -1
  if ((actor.soulPaintRounds || 0) > 0) {
    if (Math.random() < 0.20) {
      return { canAct: false, reason: 'soul_paint', effects: [...preEffects] };
    }
    const dropEffects = [];
    const pool = [101, 102, 103, 104, 105, 111, 113, 115];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    pool.slice(0, 3).forEach(p => {
      gainStat(actor, p, -1, { effects: dropEffects, srcId: 10376, srcType: 3, atkId: actor.id, srcServantId: actor.id, phase });
    });
    return { canAct: true, effects: [...preEffects, ...dropEffects] };
  }

  // 混乱状态 33% 概率攻击自身
  if (buffs[BUFF_IDS.CONFUSION] && Math.random() < 0.33) {
    const atkLv = (actor.statLevels && actor.statLevels[101]) != null ? actor.statLevels[101] : (actor.phy_atk_lv || 0);
    const defLv = (actor.statLevels && actor.statLevels[103]) != null ? actor.statLevels[103] : (actor.phy_def_lv || 0);
    const atk = actor.attrs.phy_atk * attrLvMul(atkLv);
    const def = actor.attrs.phy_def * attrLvMul(defLv);
    // 同主骨架口径：(lv+5)/50 × atk/def × 威力40
    const selfDmg = Math.max(1, Math.round(((Number(actor.level) || 1) + 5) / 50 * (40 * atk) / Math.max(1, def)));
    const finalHp = Math.max(0, actor.hp - selfDmg);
    actor.hp = finalHp;
    return {
      canAct: false,
      selfHit: true,
      selfDmg,
      finalHp,
      effects: [...preEffects, {
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [actor.id],
        src_type: 1,
        src_id: BUFF_FEATURE_IDS[BUFF_IDS.CONFUSION].trigger,
        id: BUFF_FEATURE_IDS[BUFF_IDS.CONFUSION].trigger, // 90402
        effect_phase: phase,
        change_type: 0,
        change_value: [],
        remove_round: 0,
      }],
    };
  }

  return { canAct: true, effects: preEffects };
}

// 回合末异常状态伤害扣减、专属天赋结算与持续时间自然衰减
function settleRoundEndTicks(units, battleState) {
  if (battleState) {
    battleState.soundUsedSide = {};
    battleState.yanheBuffActive = {};
    battleState.aphroditeNonSameBoost = {};
    battleState.supportUsedSide = {};
  }
  const effects = [];
  const rnd = Math.random; // 回合末随机效果（白米饭等）
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 批次H1 禁疗快照：回合末的治疗入口（泉涌/圣器回血）必须吃到「本回合仍在生效」的禁疗，
    // 而 healBan/healBlock 的递减行在本循环更早处执行——这里在递减前拍一份乘区供治疗段使用。
    const roundEndHealMul = healReceivedMul(u);

    // 重置本回合受击标记供下回合重新统计（夏色祭友情的力量等判定）
    u.hitThisRound = false;
    u.hitByServants = [];
    u.flinch = false;
    u.actedThisRound = false;
    u.fubukiDmgBoost = 0;
    u.gatanoHitThisRound = false;
    if (u.petrifyRounds > 0) {
      u.petrifyRounds -= 1;
      if (u.petrifyRounds <= 0) {
        u.petrified = false;
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 922402, // 石化解除 tips: "#tar的石化状态解除了！"
          id: 922402,
          effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
          change_type: 0,
          change_value: [],
          remove_round: 0,
        });
      }
    }
    if (u.tauntRounds > 0) {
      u.tauntRounds -= 1;
      if (u.tauntRounds <= 0) {
        u.tauntedBy = null;
      }
    }
    // 芬芳之守护配套：下回合不进入异常状态的窗口递减（20970 施加，异常施加口消费）
    if ((u.noAbnormalRounds || 0) > 0) u.noAbnormalRounds -= 1;
    // 毒龙之体（22250 那伽）：被标记者回合末损失那伽最大生命 10%
    if (u.nagaMarked) {
      Object.keys(u.nagaMarked).forEach(k => {
        const naga = (units || []).find(x => x && Number(x.id) === Number(k));
        if (naga && naga.hp > 0) {
          const dmg = Math.max(1, Math.round((naga.maxHp || (naga.attrs && naga.attrs.hp) || 1) * 0.10));
          u.hp = Math.max(0, u.hp - dmg);
          effects.push({
            trigger_count: 0, atk_servant_id: naga.id, src_servant_id: naga.id, tar_servant_ids: [u.id],
            src_type: 1, src_id: 22250, id: 22250, effect_phase: 7,
            change_type: 200000, change_value: [-dmg], remove_round: 0,
          });
        }
        u.nagaMarked[k] -= 1;
        if (u.nagaMarked[k] <= 0) delete u.nagaMarked[k];
      });
    }
    // 批次F 标记递减
    if (u.floatRounds > 0) u.floatRounds -= 1;
    if (u.gazeRounds > 0) { u.gazeRounds -= 1; if (u.gazeRounds <= 0) u.gazeSkillId = null; }
    if (u.lamentDeferRounds > 0) u.lamentDeferRounds -= 1;
    // 百炼之拳（10179）配套：「上回合被攻击技能伤害」快照（hitThisRound 随后清零）
    u.hitByAtkLastRound = !!u.hitThisRound;
    // 回溯之剑（10209）配套：按来源快照「上回合被谁的技能伤害打过」（hitFromThisRound 随后清零）
    u.hitByFromLastRound = u.hitFromThisRound || null;
    u.hitFromThisRound = null;
    // 陨石暴击（10121）配套：过期的必中标记清理（round 门控本已使其失效，这里防积累）
    if (u.nextSureHit && battleState && u.nextSureHit.round <= Number(battleState.round || 0)) u.nextSureHit = null;
    // 批次H1/H2 回合侧递减（施放回合算第 1 回合，与 magicBarrierRounds 同口径）
    if ((u.aoeImmuneRounds || 0) > 0) u.aoeImmuneRounds--;
    if ((u.teamSpeedMulRounds || 0) > 0) u.teamSpeedMulRounds--;
    if ((u.inDmgUpRounds || 0) > 0) u.inDmgUpRounds--;
    // 10391 奉献誓约：吸引次数耗尽的"己方较高攻击+1"在本回合末结算（客户端可见通道）
    if ((u.devotionAtkUpPending || 0) > 0) {
      const stacks = Number(u.devotionAtkUpPending) || 0;
      u.devotionAtkUpPending = 0;
      const hi = (u.attrs && u.attrs.phy_atk >= u.attrs.mag_atk) ? 101 : 102;
      const other = hi === 101 ? 102 : 101;
      for (let k = 0; k < stacks; k++) {
        let real = gainStat(u, hi, 1, { effects, srcId: 10391, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
        if (real === 0) real = gainStat(u, other, 1, { effects, srcId: 10391, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      }
    }
    if ((u.teamDmgDownRounds || 0) > 0) { u.teamDmgDownRounds -= 1; if (u.teamDmgDownRounds <= 0) u.teamDmgDownPct = 0; }
    if ((u.teamDmgUpRounds || 0) > 0) { u.teamDmgUpRounds -= 1; if (u.teamDmgUpRounds <= 0) u.teamDmgUpPct = 0; }
    if ((u.healReceivedBoostRounds || 0) > 0) { u.healReceivedBoostRounds -= 1; if (u.healReceivedBoostRounds <= 0) u.healReceivedBoostPct = 0; }
    if ((u.ascendRounds || 0) > 0) u.ascendRounds--;
    if ((u.inDmgDownRounds || 0) > 0) { u.inDmgDownRounds -= 1; if (u.inDmgDownRounds <= 0) u.inDmgDownPct = 0; }
    // 10253 王座的守护：受击加攻在回合末结算（客户端可见），每次受击较高攻 +1
    if ((u.kingsGuardHits || 0) > 0) {
      const hits = Number(u.kingsGuardHits) || 0;
      u.kingsGuardHits = 0;
      const kgProp = (u.attrs && u.attrs.phy_atk >= u.attrs.mag_atk) ? 101 : 102;
      const kgOther = kgProp === 101 ? 102 : 101;
      for (let i = 0; i < hits; i++) {
        let kgReal = gainStat(u, kgProp, 1, { effects, srcId: 10253, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
        if (kgReal === 0) gainStat(u, kgOther, 1, { effects, srcId: 10253, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      }
    }
    if ((u.kingsGuardRounds || 0) > 0) u.kingsGuardRounds -= 1;
    if ((u.reflectDirectRounds || 0) > 0) u.reflectDirectRounds -= 1;
    if ((u.eternalReleaseRounds || 0) > 0) {
      u.eternalReleaseRounds -= 1;
      if (u.eternalReleaseRounds <= 0) { u.eternalReleaseRounds = 0; u.eternalReleased = true; }
    }
    if ((u.forgiveDmgRounds || 0) > 0) {
      u.forgiveDmgRounds -= 1;
      if (u.forgiveDmgRounds <= 0) { u.forgiveDmgRounds = 0; u.forgiveDmgPct = 0; u.forgiveCritPct = 0; }
    }
    // 10263 血坏：回合末损失 最大HP×回合数×10%（上限30%，非致死）
    if ((u.bloodRuinRounds || 0) > 0) {
      u.bloodRuinTurn = (u.bloodRuinTurn || 0) + 1;
      const pct = Math.min(Number(u.bloodRuinMaxPct) || 30, (Number(u.bloodRuinPerTurnPct) || 10) * u.bloodRuinTurn);
      const loss = Math.max(1, Math.round((u.maxHp || 1) * pct / 100));
      const before = Math.round(u.hp);
      u.hp = Math.max(1, u.hp - loss);
      const real = before - Math.round(u.hp);
      if (real > 0) effects.push({
        trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
        src_type: 3, src_id: 10263, id: 60120, effect_phase: 7,
        change_type: 200000, change_value: [-real], remove_round: 0,
      });
      u.bloodRuinRounds -= 1;
    }
    // 10353 纯洁之心：每回合结束随机提升 1 级能力等级（共 3 回合，施放回合算第 1 回合）
    if ((u.pureHeartRounds || 0) > 0) {
      const phProp = [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)];
      gainStat(u, phProp, 1, { effects, srcId: 10353, srcType: 3, atkId: u.pureHeartSrcId || u.id, srcServantId: u.id, phase: 7 });
      u.pureHeartRounds -= 1;
      if (u.pureHeartRounds <= 0) u.pureHeartRounds = 0;
    }
    // 兴奋的秘泉（10168）：回合末损失最大生命 20%，共 3 回合（施放回合算第 1 回合）；
    // 与既有自损口径一致，最低保留 1 HP（不直接致死）。到期发 11502「兴奋的秘泉消失」。
    if ((u.exciteSpringRounds || 0) > 0) {
      const springPct = Number(u.exciteSpringHpLossPct) || 20;
      const hpBefore = Math.round(u.hp);
      const loss = Math.max(1, Math.round((u.maxHp || 1) * springPct / 100));
      u.hp = Math.max(1, u.hp - loss);
      const realLoss = hpBefore - Math.round(u.hp);
      if (realLoss > 0) {
        effects.push({
          trigger_count: 0, atk_servant_id: u.exciteSpringSrcId || u.id, src_servant_id: u.id,
          tar_servant_ids: [u.id], src_type: 3, src_id: 10168, id: 11501, effect_phase: 7,
          change_type: 200000, change_value: [-realLoss], remove_round: 0,
        });
      }
      u.exciteSpringRounds--;
      if (u.exciteSpringRounds <= 0) {
        u.exciteSpringRounds = 0;
        effects.push({
          trigger_count: 0, atk_servant_id: u.exciteSpringSrcId || u.id, src_servant_id: u.id,
          tar_servant_ids: [u.id], src_type: 3, src_id: 10168, id: 11502, effect_phase: 7,
          change_type: 0, change_value: [0], remove_round: 0,
        });
      }
    }
    // 绝对防御（10007）：1 回合保护，回合末解除（round 门控在消费侧另有跨波次兜底）
    if (u.absoluteDef) { u.absoluteDef = false; u.absoluteDefRound = 0; }
    // 全局推演（10259）：准备回合结束 → 全部能力等级 +2（延时类，批次H3）
    if (battleState && u.globalDeductionAt != null && u.globalDeductionAt === Number(battleState.round || 0)) {
      [101, 102, 103, 104, 105].forEach(p => {
        gainStat(u, p, 2, { effects, srcId: 10259, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      });
      u.globalDeductionAt = null;
    }
    // 天击（10261）：攻击技封锁 1 回合，回合末递减
    if ((u.noAttackRounds || 0) > 0) u.noAttackRounds--;
    // 彩虹之神使（21590）：辅助回合的减伤窗口清零
    u.irisMitActive = false;

      // 夜刀神十香（21680 公主）：物防在回合结束时恢复
      if (u.tohkaDefLowered) {
        gainStat(u, 103, 1, { effects, srcId: 21680, atkId: u.id, srcServantId: u.id, phase: 7 });
        u.tohkaDefLowered = false;
      }
    u.tohkaTargeted = false;

    // Phase 6 回合末专属结算：
    u.hitsTakenThisRound = 0;
    u.frostErosionDone = false;
    u.strangledThisRound = false;
    u.syaroDmgBonus = 0;
    // 三百一十三：沉睡（睡美人 232200）/深层睡眠（诺登斯 22460）到期 → 300020 摘图标
    // （客户端不自治过期；入场/施加点的 300019 见 checkEntranceTalents / settleSkill）
    if (u.sleepCurseRounds > 0) {
      u.sleepCurseRounds--;
      if (u.sleepCurseRounds <= 0) {
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 1, src_id: 60120, id: 60120, effect_phase: 7,
          change_type: 300020, change_value: [232200], remove_round: 0,
        });
      }
    }
    if (u.deepSleepRounds > 0) {
      u.deepSleepRounds--;
      if (u.deepSleepRounds <= 0) {
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 1, src_id: 60120, id: 60120, effect_phase: 7,
          change_type: 300020, change_value: [22460], remove_round: 0,
        });
      }
    }
    if (u.cthyllaBoundRounds > 0) u.cthyllaBoundRounds--;
    if (u.tamagoyakiCooldown > 0) u.tamagoyakiCooldown--;

    // P3-A 专属改写·回合侧（二百二十六）
    if ((u.mentalMathRounds || 0) > 0) {
      gainStat(u, 111, 1, { effects, srcId: 10378, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      gainStat(u, (u.attrs && u.attrs.phy_atk >= u.attrs.mag_atk) ? 101 : 102, 1, { effects, srcId: 10378, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.mentalMathRounds--;
    }
    if ((u.coffeeDefDownRounds || 0) > 0) {
      gainStat(u, 103, -1, { effects, srcId: 10384, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      gainStat(u, 104, -1, { effects, srcId: 10384, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.coffeeDefDownRounds--;
    }
    if ((u.breakthroughRounds || 0) > 0) {
      (units || []).forEach(a => {
        if (!a || a.hp <= 0 || a.side !== u.side) return;
        gainStat(a, (a.attrs && a.attrs.phy_atk >= a.attrs.mag_atk) ? 101 : 102, 1, { effects, srcId: 10382, srcType: 3, atkId: u.id, srcServantId: a.id, phase: 7 });
        gainStat(a, 105, 1, { effects, srcId: 10382, srcType: 3, atkId: u.id, srcServantId: a.id, phase: 7 });
      });
      u.breakthroughRounds--;
    }
    if ((u.healBanRounds || 0) > 0) u.healBanRounds--;
    if ((u.defPierceRounds || 0) > 0) u.defPierceRounds--;
    if ((u.soulPaintRounds || 0) > 0) u.soulPaintRounds--;
    // P3-B 标志倒计时（二百二十七）
    if ((u.assaultRounds || 0) > 0) {
      gainStat(u, 101, 1, { effects, srcId: 10122, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      gainStat(u, 102, 1, { effects, srcId: 10122, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.assaultRounds--;
    }
    if ((u.sheepDecayRounds || 0) > 0) {
      gainStat(u, u.sheepDecayProp || 103, -1, { effects, srcId: 10367, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.sheepDecayRounds--;
    }
    if ((u.supportBanRounds || 0) > 0) u.supportBanRounds--;
    if ((u.critVulnRound || 0) > 0) u.critVulnRound--;
    if ((u.critVulnTargetRound || 0) > 0) u.critVulnTargetRound--;
    // P3-C 标志/回合效果（二百二十八）
    if ((u.rainShieldRounds || 0) > 0) {
      (units || []).forEach(a => {
        if (!a || a.hp <= 0 || a.side !== u.side) return;
        exclusiveAddShield(u, a, Math.max(1, Math.round((a.maxHp || 1) * 0.08)), { effects, phase: 7 }, 10011);
      });
      u.rainShieldRounds--;
    }
    if ((u.slowCookRounds || 0) > 0) {
      const bump = 2 + (Math.random() < 0.5 ? 1 : 0);
      gainStat(u, (u.attrs && u.attrs.phy_atk >= u.attrs.mag_atk) ? 101 : 102, bump, { effects, srcId: 10404, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      gainStat(u, 105, bump, { effects, srcId: 10404, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.slowCookRounds--;
    }
    if ((u.springRounds || 0) > 0 && u.hp > 0) {
      const maxH = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
      // 批次H1 禁疗覆盖修复：泉涌回血纳入禁疗（用回合初快照，healBan 递减行已在其前执行）
      const gain = Math.max(1, Math.ceil(maxH / 12)) * roundEndHealMul;
      const after = Math.min(maxH, u.hp + gain);
      if (after > u.hp) {
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 3, src_id: 10008, id: 60120, effect_phase: 7,
          change_type: 200000, change_value: [after - u.hp], remove_round: 0,
        });
        u.hp = after;
      }
      u.springRounds--;
    }
    if ((u.cthyllaBoundRounds || 0) > 0) {
      // 元素版暴雨召来（2641013）：融合雨期间回合末对融合目标造成最大生命 10%（窗口=天气时长，与雨天双门控）
      if (battleState && Number(battleState.fusionRainUntil || 0) >= Number(battleState.round)
          && battleState.weather && battleState.weather.start_weather === WEATHER_IDS.RAIN) {
        const maxH2 = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
        const rdmg = Math.max(1, Math.round(maxH2 * 0.10));
        u.hp = Math.max(0, u.hp - rdmg);
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 3, src_id: 10011, id: 60120, effect_phase: 7,
          change_type: 200000, change_value: [-rdmg], remove_round: 0,
        });
      }
    }
    if ((u.lightDmgUpRounds || 0) > 0) u.lightDmgUpRounds--;
    if ((u.nightFeastRounds || 0) > 0) u.nightFeastRounds--;
    // 屏障类持续时间递减（力量屏障 10001 与法力屏障 10002 同构；法力屏障原先只置不递减，属既有缺口，此处一并修）
    if ((u.phyBarrierRounds || 0) > 0) u.phyBarrierRounds--;
    if ((u.magicBarrierRounds || 0) > 0) u.magicBarrierRounds--;
    if ((u.fleshBoostRounds || 0) > 0) u.fleshBoostRounds--;
    if ((u.nightLordRounds || 0) > 0) {
      const nw = battleState && battleState.weather && battleState.weather.start_weather;
      u.nightNoDrop = (Number(nw) === WEATHER_IDS.NIGHT || isNyxNightTime(nw));
      u.nightLordRounds--;
      if (u.nightLordRounds <= 0) u.nightNoDrop = false;
    }
    if (u.firstHitTo1 && u.firstHitTo1Round && battleState && battleState.round >= u.firstHitTo1Round) u.firstHitTo1 = false;
    if ((u.statDownImmuneRounds || 0) > 0) u.statDownImmuneRounds--;
    if ((u.shieldImmuneRounds || 0) > 0) u.shieldImmuneRounds--;
    if ((u.defLockRounds || 0) > 0) u.defLockRounds--;
    // P1：四个"只写不减"的专属标记（否则永久生效）
    if ((u.susaMarkRounds || 0) > 0) { u.susaMarkRounds--; if (u.susaMarkRounds <= 0) u.susaMarkOwner = null; }
    if ((u.grudgeAbsorbRounds || 0) > 0) u.grudgeAbsorbRounds--;
    if ((u.sweetDreamRounds || 0) > 0) u.sweetDreamRounds--;
    if ((u.lightSwordRounds || 0) > 0) u.lightSwordRounds--;
    if ((u.healBlockRounds || 0) > 0) u.healBlockRounds--;
    if ((u.healHalfRounds || 0) > 0) u.healHalfRounds--;
    if ((u.randomDefDownRounds || 0) > 0) {
      gainStat(u, Math.random() < 0.5 ? 103 : 104, -1, { effects, srcId: 10384, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.randomDefDownRounds--;
    }
    if ((u.roundEndAllyRandom || 0) > 0) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      if (allies.length) gainStat(allies[Math.floor(Math.random() * allies.length)], [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], 1, { effects, srcId: 10382, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.roundEndAllyRandom--;
    }
    if ((u.slowCookBaseRounds || 0) > 0) {
      const need = Math.round((u.maxHp || 1) * (u.slowCookBasePct || 15) / 100);
      const oldShield = Math.round(Number(u.shield) || 0);
      const consumed = Math.min(need, oldShield);
      if (oldShield >= need) u.shield = oldShield - need;
      else { u.shield = 0; u.nextShieldMul = 2; }
      // 2026-10-27：扣盾/清盾补 200001 负值增量（静默 60120，10404 无 FightFeature 条目）
      if (consumed > 0) {
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 3, src_id: 10404, id: 60120, effect_phase: 7,
          change_type: 200001, change_value: [-consumed], remove_round: 0,
        });
      }
      gainStat(u, (u.attrs && u.attrs.phy_atk >= u.attrs.mag_atk) ? 101 : 102, 1, { effects, srcId: 10404, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      gainStat(u, 105, 1, { effects, srcId: 10404, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.slowCookBaseRounds--;
    }
    if ((u.roundEndRandomDebuff || 0) > 0) {
      gainStat(u, [101, 102, 103, 104, 105][Math.floor(Math.random() * 5)], -1, { effects, srcId: 10367, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.roundEndRandomDebuff--;
    }
    if (u.roundEndStat && (u.roundEndStat.rounds || 0) > 0) {
      gainStat(u, u.roundEndStat.prop, u.roundEndStat.delta, { effects, srcId: 10378, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.roundEndStat.rounds--;
    }
    if ((u.debuffDoubleRounds || 0) > 0) u.debuffDoubleRounds--;
    if ((u.stanceRounds || 0) > 0) u.stanceRounds--;
    if ((u.animalRepelRounds || 0) > 0) { u.animalRepelRounds--; if (u.animalRepelRounds <= 0) u.animalRepelOwner = null; }
    if ((u.critVulnMagicRounds || 0) > 0) u.critVulnMagicRounds--;
    if ((u.immuneCritRounds || 0) > 0) { u.immuneCritRounds--; if (u.immuneCritRounds <= 0) u.immuneCrit = false; }
    if ((u.fragarachRounds || 0) > 0) u.fragarachRounds--;
    if ((u.brionacRounds || 0) > 0) u.brionacRounds--;
    if ((u.judgmentRounds || 0) > 0 && !u.judgmentPermanent) { u.judgmentRounds--; if (u.judgmentRounds <= 0) u.noPositiveRounds = 0; }
    if ((u.lightBearRounds || 0) > 0) {
      gainStat(u, Math.random() < 0.5 ? 103 : 104, 1, { effects, srcId: 10387, srcType: 3, atkId: u.id, srcServantId: u.id, phase: 7 });
      u.lightBearRounds--;
    }

    // 亚瑟王（23000 雾夜启明）：回合结束恢复15%最大生命
    if (u.talent === 23000 && u.hp > 0) {
      const maxH = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
      const healAmt = Math.min(maxH - u.hp, Math.floor(maxH * 0.15));
      if (healAmt > 0) {
        u.hp += healAmt;
        // 2026-10-27：回血补 30531 甘露通道（狼人 20870 同款）
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 1, src_id: 30531, id: 30531, effect_phase: 7,
          change_type: 200000, change_value: [healAmt], remove_round: 0,
        });
      }
    }

    // 努特（22830 死亡之风）：回合结束扣除10%最大生命
    if (u.curseOfDead > 0 && u.hp > 0) {
      const maxH = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
      const dmgAmt = Math.min(u.hp, Math.floor(maxH * 0.10));
      u.hp = Math.max(0, u.hp - dmgAmt);
      u.curseOfDead--;
      // 2026-10-27：扣血补 200000 负值（静默 60120）——本段可致死，客户端必须看到掉血/阵亡
      effects.push({
        trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
        src_type: 3, src_id: 22830, id: 60120, effect_phase: 7,
        change_type: 200000, change_value: [-dmgAmt], remove_round: 0,
      });
      // 三百一十三：诅咒递减归零 → 300020 摘图标
      if (u.curseOfDead <= 0) {
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 1, src_id: 60120, id: 60120, effect_phase: 7,
          change_type: 300020, change_value: [22830], remove_round: 0,
        });
      }
    }

    // 保登心爱（22870 天然自来熟）：每存在一名点兔誓灵，随机一项能力+1
    if (u.talent === 22870 && u.hp > 0) {
      const rabbitCount = (units || []).filter(x => x && x.hp > 0 && x.side === u.side && isGochuumon(x.type)).length;
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      u.statLevels = u.statLevels || {};
        for (let i = 0; i < rabbitCount; i++) {
          const p = props[Math.floor(Math.random() * props.length)];
          gainStat(u, p, 1, { effects, srcId: 22870, atkId: u.id, srcServantId: u.id, phase: 7 });
        }
    }

    // 宇治松千夜（22890 腹黑气场）：回合结束敌方全体升防
    if (u.talent === 22890 && u.hp > 0) {
      const foes = (units || []).filter(x => x && x.hp > 0 && x.side !== u.side);
      const rabbitCount = (units || []).filter(x => x && x.hp > 0 && isGochuumon(x.type)).length;
      foes.forEach(f => {
        f.statLevels = f.statLevels || {};
        if (rabbitCount > 0) {
          for (let i = 0; i < rabbitCount; i++) {
            const p = Math.random() < 0.5 ? 103 : 104;
            gainStat(f, p, 1, { effects, srcId: 22890, atkId: u.id, srcServantId: u.id, phase: 7 });
          }
        } else {
          const aliveTotal = (units || []).filter(x => x && x.hp > 0).length;
          [103, 104].forEach(p => {
            gainStat(f, p, aliveTotal, { effects, srcId: 22890, atkId: u.id, srcServantId: u.id, phase: 7 });
          });
        }
      });
    }

    // 北京烤鸭（23090 傲娇反击）：魔攻等级<=1时对敌全体造成威力50火魔攻
    // 2026-10-20 修复：原来只改 hp，回合末的先手伤害完全不可见；现在每个目标补一条演出 effect。
    if (u.talent === 23090 && u.hp > 0) {
      const matkLv = (u.statLevels && u.statLevels[102]) || 0;
      if (matkLv <= 1) {
        const foes = (units || []).filter(x => x && x.hp > 0 && x.side !== u.side);
        foes.forEach(f => {
          const pAtk = (u.attrs ? u.attrs.mag_atk : (u.mag_atk || 100)) * attrLvMul(matkLv);
          const pDef = (f.attrs ? f.attrs.mag_def : (f.mag_def || 100)) * attrLvMul((f.statLevels && f.statLevels[104]) || 0);
          const dmg = Math.max(1, Math.round((50 * pAtk) / (pAtk + pDef) * 1.5 * naturePer(natureRelate(2, f.nature))));
          f.hp = Math.max(0, f.hp - dmg);
          effects.push(featureFxEffect(u, 23090, FX_23090, 200000, [-dmg], [f.id], 7)); // 7=TRIGGER_TIME_AFTER_ROUND
        });
      }
    }

        // 伊吹风子（22340 最终海星使）：每拥有 1 颗海星标记，随机能力等级提升 1 级
    if (u.starfish > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const changeVals = [];
      for (let i = 0; i < u.starfish; i++) {
        const p = props[Math.floor(Math.random() * props.length)];
        u.statLevels = u.statLevels || {};
        const oldLv = u.statLevels[p] || 0;
        const newLv = Math.max(-6, Math.min(6, oldLv + 1));
        const realDelta = newLv - oldLv;
        u.statLevels[p] = newLv;
        const attrName = PROP_ATTR_NAMES[p];
        if (attrName) u[attrName] = newLv;
        if (realDelta > 0) changeVals.push(encodeAttrVal(p, realDelta, newLv));
      }
      if (changeVals.length > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 22340,
          id: 22340,
          effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
          change_type: 100000,
          change_value: changeVals,
          remove_round: 0,
        });
      }
    }

    // 鲲（21280 逍遥游）：回合结束时，随机 2 项不同能力提升 1 级；若命中魔攻（102）或速度（105），下回合水伤 +50%
    //
    // ⚠️ 展示口径（2026-10-27 真机工单「鲲的被动还是只有上升一级」）：
    //   effect.id 必须逐项填**官方能力变化条目** 20001~20008（PROP_FEATURE_IDS），不是天赋 id 21280。
    //   客户端 FeatureLoop.dealFeatureEff（Modules/fight/FeatureCase/FeatureLoop.lua:137）按 `id`
    //   取展示条目：`GetFeature(slot8.id)` 无 tips 就整段跳过飘字；FightFeature[21280] 只有 name
    //   （无 tips、无 act），所以 187 拆条后仍「零文字反馈」。再叠上血条图标表只有 7 项
    //   （无会心 111，Modules/scene/SceneUnitHeadItem.lua:95），8 选 2 有 25% 的回合第二项落在会心，
    //   玩家就只剩一个图标 —— 这才是「只有上升一级」的体感来源。
    //   src_id 仍填 21280：横幅取名（FeatureTipsLeft 读 src_id）与客户端分组键
    //   （FightLoop.lua:1456 `src_servant_id .. "#" .. src_id`）都靠它，两条才会归进同一批动画。
    //   这是 gainStat() 的既有默认写法（id 默认 PROP_FEATURE_IDS[prop]），也是 21000 处女座同款。
    if (u.talent === 21280) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const shuffled = props.slice().sort(() => Math.random() - 0.5);
      const picked = shuffled.slice(0, 2);
      let triggeredWaterBoost = false;
      picked.forEach(p => {
        u.statLevels = u.statLevels || {};
        const oldLv = u.statLevels[p] || 0;
        const newLv = Math.max(-6, Math.min(6, oldLv + 1));
        const realDelta = newLv - oldLv;
        // ±6 顶住时 realDelta=0：不发事件（客户端对 0 会 printError「能力等级变化为0」）
        if (realDelta > 0) {
          u.statLevels[p] = newLv;
          const attrName = PROP_ATTR_NAMES[p];
          if (attrName) u[attrName] = newLv;
          effects.push({
            trigger_count: 0,
            atk_servant_id: u.id,
            src_servant_id: u.id,
            tar_servant_ids: [u.id],
            src_type: 1, // FIGHT_EFF_FEATURE
            src_id: 21280, // 横幅「鲲的 逍遥游」
            id: PROP_FEATURE_IDS[p] || 20001, // 官方能力变化条目（带 tips + act 20001）
            effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
            change_type: 100000,
            change_value: [encodeAttrVal(p, realDelta, newLv)],
            remove_round: 0,
          });
        }
        // 水伤蓄力按"抽中"判定，与是否顶到上限无关（官方描述只要求命中魔攻/速度）
        if (p === 102 || p === 105) {
          triggeredWaterBoost = true;
        }
      });
      if (triggeredWaterBoost) {
        u.waterDmgBoostNextRound = 0.50;
      }
    }

    // 圣器「回复的甘露/圣水」族（CfgItems 11000001~11000004）：回合结束回复 2/3/5/8% 最大生命。
    // 客户端不自行结算圣器（纯服务端权威，2026-10-17 真机实证：装圣水整场 HP 不变），
    // 展示走官方治疗特性 30531/30541/30551/30561（FightFeature.lua act=20015 回血动画 + tips 带 #value）。
    // 只有 1100000x 是回血圣器，别顺手把同族其它 id 带进来。
    // 放在灼伤/中毒结算之后：中毒致死则不再回血（hp<=0 已跳过）。
    if (u.hp > 0) {
      const heal = RELIC_ROUND_HEAL[u.relicId];
      if (heal) {
        const maxH = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
        // 批次H1 禁疗覆盖修复：圣器回合回血纳入禁疗（用回合初快照——递减行已在其前执行，
        // 直接调 healReceivedMul 会读到已递减的值，导致「5回合禁疗」的第 1 回合末圣水照回）
        const gained = Math.min(maxH, u.hp + Math.ceil(maxH * heal.pct / 100 * roundEndHealMul)) - u.hp;
        if (gained > 0) {
          u.hp += gained;
          effects.push({
            trigger_count: 0,
            atk_servant_id: u.id,
            src_servant_id: u.id,
            tar_servant_ids: [u.id],
            src_type: 1, // FIGHT_EFF_FEATURE
            src_id: heal.feature,
            id: heal.feature,
            effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
            change_type: 200000, // FIGHT_EFF_CHANGE_TYPE_HP（正值=治疗）
            change_value: [gained],
            remove_round: 0,
          });
        }
      }

      // 圣器「解除异常」族（治愈之实 Lv1-3 / 金苹果 / 提耶特）：一场战斗一次，自动清除指定 buff。
    // CfgItems「解除中毒/烧伤/…（一场战斗只能发动1次）」。回合末自动触发（玩家无需操作）。
    if (u.relicCure && !u.relicCureUsed) {
      const removed = [];
      (u.relicCure.buffs || []).forEach(bid => {
        if (u.buffs && u.buffs[bid]) { delete u.buffs[bid]; removed.push(bid); }
      });
      if (removed.length) {
        u.relicCureUsed = true;
        removed.forEach(bid => {
          const feat = BUFF_FEATURE_IDS[bid];
          effects.push({
            trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id,
            tar_servant_ids: [u.id], src_type: 1,
            src_id: (feat && feat.remove) || 0, id: (feat && feat.remove) || 0,
            effect_phase: 7, change_type: 300020, // REDUCE_BUFF
            change_value: [bid], remove_round: 0,
          });
        });
      }
    }

    // 木刻海星（风子专属）：可解除自身激怒状态（一场战斗一次，回合末自动触发——同「解除异常」族口径）
    {
      const excF = u.relicMisc && u.relicMisc.excl;
      if (excF && excF.fukoCureEnrage && !u.relicFukoCureUsed && u.buffs && u.buffs[BUFF_IDS.TAUNT]) {
        delete u.buffs[BUFF_IDS.TAUNT];
        u.relicFukoCureUsed = true;
        const featF = BUFF_FEATURE_IDS[BUFF_IDS.TAUNT];
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id,
          tar_servant_ids: [u.id], src_type: 1,
          src_id: (featF && featF.remove) || 0, id: (featF && featF.remove) || 0,
          effect_phase: 7, change_type: 300020,
          change_value: [BUFF_IDS.TAUNT], remove_round: 0,
        });
      }
    }

    // 圣器「回合末自伤」（毁灭之戟 Lv1-3 / 阿贾伽瓦）：CfgItems「回合结束时损失10%最大生命值的血量」。
      // 只在 hp>0 时结算，扣到 0 为止（不触发濒死保命——那是"受到技能伤害"口径）。
      if (u.relicDmg && u.relicDmg.roundSelfDamage) {
        const maxH = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
        const selfDmg = Math.max(1, Math.ceil(maxH * u.relicDmg.roundSelfDamage));
        u.hp = Math.max(0, u.hp - selfDmg);
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          // src_type=3（技能源）只影响 src_id 的查表，**不影响 id**：
          // dealFeatureEff 对每条 effect 都 `GetFeature(id, true)`（无条件 true，asm 实证），
          // 所以 id 必须是表内条目 —— 原写 200000（表外）会让客户端无条件 printError
          // 「不存在的特性ID：200000」（2026-10-24 盘点 §三 记录、2026-10-27 复现）。
          // 60120「伤害提升」showName=0 且无 tips/act ⇒ 全程静默：血条照动，不弹文案
          // （与 elementStateEffect / 助战扣血同一约定）。
          src_type: 3,
          src_id: 18003001,
          id: 60120, // 静默 HP 变更（无飘字需求，血条本身会动）
          effect_phase: 7,
          change_type: 200000,
          change_value: [-selfDmg],
          remove_round: 0,
        });
      }

      // 白米饭：回合结束随机提升 1 级能力或恢复 6% 生命（官方两个效果二选一，随机；
      // 白米饭（誓灵 3514005）携带时两种效果同时生效）
      if (u.relicMisc && u.relicMisc.roundRandomStatOrHeal) {
        const maxH = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
        const riceBoth = !!(u.relicMisc.excl && u.relicMisc.excl.riceBoth);
        const doStat = riceBoth || rnd() < 0.5;
        const doHeal = riceBoth || !doStat;
        if (doStat) {
          const props = [101, 102, 103, 104, 105, 111, 113, 115];
          const p = props[Math.floor(rnd() * props.length)];
          u.statLevels = u.statLevels || {};
          const oldLv = u.statLevels[p] || 0;
          const newLv = Math.max(-6, Math.min(6, oldLv + 1));
          if (newLv !== oldLv) {
            u.statLevels[p] = newLv;
            const an = PROP_ATTR_NAMES[p];
            if (an) u[an] = newLv;
            effects.push({
              trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id,
              tar_servant_ids: [u.id], src_type: 1,
              src_id: PROP_FEATURE_IDS[p] || 20001, id: PROP_FEATURE_IDS[p] || 20001,
              effect_phase: 7, change_type: 100000,
              change_value: [encodeAttrVal(p, 1, newLv)], remove_round: 0,
            });
          }
        }
        if (doHeal) {
          const healed = Math.min(maxH - u.hp, Math.max(1, Math.ceil(maxH * 0.06)));
          if (healed > 0) {
            u.hp += healed;
            effects.push({
              trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id,
              tar_servant_ids: [u.id], src_type: 1, src_id: 30531, id: 30531,
              effect_phase: 7, change_type: 200000, change_value: [healed], remove_round: 0,
            });
          }
        }
      }
      // 联动圣器「双子互回」：尤莉的步兵铳/千户的日记本——回合结束使搭档回复 8% 最大生命
      {
        const excR = u.relicMisc && u.relicMisc.excl;
        if (u.hp > 0 && excR && (excR.yuuriHealChito || excR.chitoHealYuuri)) {
          const mateType = excR.yuuriHealChito ? 3245001 : 3242002;
          const mate = (units || []).find(x => x && x.hp > 0 && x.side === u.side && Number(x.type) === mateType);
          if (mate) {
            const mateMax = mate.maxHp || (mate.attrs && mate.attrs.hp) || mate.hp;
            const gainedM = Math.min(mateMax, mate.hp + Math.max(1, Math.ceil(mateMax * (excR.yuuriHealChito || excR.chitoHealYuuri)))) - mate.hp;
            if (gainedM > 0) {
              mate.hp += gainedM;
              effects.push({
                trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id,
                tar_servant_ids: [mate.id], src_type: 1, src_id: 30531, id: 30531,
                effect_phase: 7, change_type: 200000, change_value: [gainedM], remove_round: 0,
              });
            }
          }
        }
      }

      // 圣器「低血回血」族（生命之符Lv1-3 / 安卡之符 / 团子）：
      // CfgItems desc「当生命值低于N%时，会回复M%HP（一次战斗仅能生效一次）」。
      // 每场战斗只触发一次，用 relicLowUsed 记；放在回合末（与圣水同区，玩家观察点一致）。
      const lhh = u.relicLowHpHeal;
      if (lhh && !u.relicLowUsed) {
        const maxH2 = u.maxHp || (u.attrs && u.attrs.hp) || u.hp;
        if (maxH2 > 0 && (u.hp / maxH2) < (lhh.threshold || 0.6)) {
          const amount = Math.ceil(maxH2 * (lhh.pct || 0) / 100);
          const gained2 = Math.min(maxH2, u.hp + amount) - u.hp;
          if (gained2 > 0) {
            u.hp += gained2;
            u.relicLowUsed = true;
            effects.push({
              trigger_count: 0,
              atk_servant_id: u.id,
              src_servant_id: u.id,
              tar_servant_ids: [u.id],
              src_type: 1,
              src_id: 30531, // 回复的甘露（act=20015 回血动画 + #value 文案）
              id: 30531,
              effect_phase: 7,
              change_type: 200000,
              change_value: [gained2],
              remove_round: 0,
            });
          }
        }
      }
    }

    if (!u.buffs) return;
    const buffKeys = Object.keys(u.buffs);
    buffKeys.forEach(bid => {
      const b = u.buffs[bid];
      if (!b) return;
      const numBid = Number(bid);

      // 灼伤扣血 (最大生命的 1/16)
      if (numBid === BUFF_IDS.BURN) {
        const dmg = Math.max(1, Math.ceil(u.maxHp / 16));
        u.hp = Math.max(0, u.hp - dmg);
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1,
          src_id: BUFF_FEATURE_IDS[BUFF_IDS.BURN].trigger,
          id: BUFF_FEATURE_IDS[BUFF_IDS.BURN].trigger, // 90102
          effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
          change_type: 200000, // HP change
          change_value: [-dmg],
          remove_round: 0,
        });
      }

      // 中毒扣血 (最大生命的 1/16)
      if (numBid === BUFF_IDS.POISON) {
        const dmg = Math.max(1, Math.ceil(u.maxHp / 16));
        u.hp = Math.max(0, u.hp - dmg);
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1,
          src_id: BUFF_FEATURE_IDS[BUFF_IDS.POISON].trigger,
          id: BUFF_FEATURE_IDS[BUFF_IDS.POISON].trigger, // 90801
          effect_phase: 7,
          change_type: 200000, // HP change
          change_value: [-dmg],
          remove_round: 0,
        });
      }

      // 时空禁锢（12395，10274 空间箭）：「每回合结束为虚空掌控的誓灵提供5点虚空」——
      // 禁锢标在对面的 21910（泡泡/犹格）身上吃这份充能（同侧镜像 21910 的场合取对面那只，
      // 与"施加者获得"的官方语义等价：禁锢只会被对面施放）。
      if (numBid === 12395) {
        const voidMaster = (units || []).find(x => x && x.hp > 0 && x.side !== u.side && x.talent === 21910);
        if (voidMaster) chargeVoid(voidMaster, 5, effects, 7, u.id);
      }

      // 衰减持续时间
      b.duration -= 1;
      if (b.duration <= 0) {
        delete u.buffs[bid];
        const feat = BUFF_FEATURE_IDS[numBid];
        if (feat && feat.remove) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: u.id,
            src_servant_id: u.id,
            tar_servant_ids: [u.id],
            src_type: 1,
            src_id: feat.remove,
            id: feat.remove,
            effect_phase: 7,
            change_type: 300020, // REDUCE_BUFF
            change_value: [numBid],
            remove_round: 0,
          });
        }
      }
    });
  });

  // 哈斯塔（22440 黄衣之王）：哈斯塔在场时持有黄印的誓灵回合结束时己方能力提升一级/敌方下降二级
  const hasturList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22440);
  if (hasturList.length > 0) {
    hasturList.forEach(hastur => {
      (units || []).forEach(tar => {
        if (!tar || tar.hp <= 0 || !tar.yellowSign) return;
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const isAlly = (tar.side === hastur.side);
        const p = props[Math.floor(Math.random() * props.length)];
        tar.statLevels = tar.statLevels || {};
        const oldLv = tar.statLevels[p] || 0;
        const delta = isAlly ? 1 : -2;
        const newLv = Math.max(-6, Math.min(6, oldLv + delta));
        const realDelta = newLv - oldLv;
        tar.statLevels[p] = newLv;
        const attrName = PROP_ATTR_NAMES[p];
        if (attrName) tar[attrName] = newLv;
        if (realDelta !== 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: hastur.id,
            src_servant_id: hastur.id,
            tar_servant_ids: [tar.id],
            src_type: 1, // FIGHT_EFF_FEATURE
            src_id: 22440,
            id: isAlly ? 20000 : 20001,
            effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
            change_type: 100000,
            change_value: [encodeAttrVal(p, realDelta, newLv)],
            remove_round: 0,
          });
        }
      });
    });
  }

  // 羲和（20380 日御）：烈日天气不会因回合数结束而消失
  if (battleState && battleState.weather && battleState.weather.start_weather === WEATHER_IDS.SUN) {
    const hasXihe = (units || []).some(u => u && u.hp > 0 && u.talent === 20380);
    if (hasXihe) {
      battleState.weather.weather_end_round = (battleState.weather.weather_end_round || 0) + 5;
    }
  }

  // 玛纳诺（22160 碧蓝海之霖）：暴雨天气下己方全员回合结束时回复1/12生命值
  if (battleState && battleState.weather && battleState.weather.start_weather === WEATHER_IDS.RAIN) {
    const manannanSides = new Set((units || []).filter(u => u && u.hp > 0 && u.talent === 22160).map(u => u.side));
    (units || []).forEach(u => {
      if (u && u.hp > 0 && manannanSides.has(u.side)) {
        const healAmt = Math.min(u.maxHp - u.hp, Math.max(1, Math.round(u.maxHp / 12)));
        if (healAmt > 0) {
          u.hp += healAmt;
          effects.push({
            trigger_count: 0,
            atk_servant_id: u.id,
            src_servant_id: u.id,
            tar_servant_ids: [u.id],
            src_type: 1,
            src_id: 22160,
            id: 22160,
            effect_phase: 7,
            change_type: 200000,
            change_value: [healAmt],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 巴罗尔（22170 衰竭之独眼）：回合结束时正前方敌方物防魔防下降1级
  const balorList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22170);
  balorList.forEach(balor => {
    const enemies = (units || []).filter(e => e && e.hp > 0 && e.side !== balor.side);
    if (enemies.length > 0) {
      const foeSameLane = enemies.filter(e => e.pos && balor.pos && e.pos[1] === balor.pos[1]);
      const targetFoe = (foeSameLane.length > 0 ? foeSameLane : enemies)
        .sort((a, b) => Math.abs((a.pos && a.pos[0]) || 0) - Math.abs((b.pos && b.pos[0]) || 0))[0];
      if (targetFoe) {
        const changes = [];
        [103, 104].forEach(p => {
          targetFoe.statLevels = targetFoe.statLevels || {};
          const oldLv = targetFoe.statLevels[p] || 0;
          const newLv = Math.max(-6, oldLv - 1);
          const delta = newLv - oldLv;
          targetFoe.statLevels[p] = newLv;
          const an = PROP_ATTR_NAMES[p];
          if (an) targetFoe[an] = newLv;
          if (delta !== 0) changes.push(encodeAttrVal(p, delta, newLv));
        });
        if (changes.length > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: balor.id,
            src_servant_id: balor.id,
            tar_servant_ids: [targetFoe.id],
            src_type: 1,
            src_id: 22170,
            id: 22170,
            effect_phase: 7,
            change_type: 100000,
            change_value: changes,
            remove_round: 0,
          });
        }
      }
    }
  });

  // 弗雷（22130 自律型圣剑）：回合结束时，己方场上每存在一名攻击等级为正的誓灵，弗雷对敌方
  // （现存最低血）追加一次「威力=该誓灵较高攻击等级*20」的单体攻击。
  // ⚠️ 两处口径（2026-11-07 玩家反馈「自律的圣剑不能造成伤害」，同日修复）：
  // ① 伤害走主骨架 (lv+5)/50 × atk/def × 威力——官方 desc（CfgTalent[22130]）「威力为较高攻击
  //    等级*20的单体攻击」中"威力"是技能威力参数（弗雷自身技能 威力40/80/95），不是最终伤害；
  //    同措辞先例＝灵蛇之珠 22040 追击（本文件 22040 段）。旧实现把 等级*20 直接当最终伤害
  //    （20~120 点固定真伤，不吃攻防/等级，UR 段每回合 ~1-2% 血）⇒ 观感="完全没伤害"。
  //    攻击者=弗雷本人（天赋名义=她的圣剑自主出击；atk/src_servant_id 本就是 frey.id），攻防取
  //    弗雷魔攻/目标魔防（speciality=102，与巳同款口径；不吃 dmgMul/暴击，追击先例同）。
  // ② 演出 id 必须用官方展示条目 22131（FightFeature[22131] act=20500 挥剑）：22130 是 name-only
  //    条目 ⇒ 客户端 FeatureLoop 走"无 act"分支静默 UpdateHP（无动画/飘字/伤害数字）。
  //    src_id 保持 22130（在表内，D9c 无红字；横幅「弗雷的自律型圣剑」由 FeatureTips 读
  //    src_id 的 name 照常显示）。22040→22041 同款。
  const freyList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22130);
  freyList.forEach(frey => {
    const allies = (units || []).filter(a => a && a.hp > 0 && a.side === frey.side);
    const enemies = (units || []).filter(e => e && e.hp > 0 && e.side !== frey.side);
    if (enemies.length > 0) {
      allies.forEach(ally => {
        const pAtk = (ally.statLevels && ally.statLevels[101]) || ally.phy_atk_lv || 0;
        const mAtk = (ally.statLevels && ally.statLevels[102]) || ally.mag_atk_lv || 0;
        const higherAtk = Math.max(pAtk, mAtk);
        if (higherAtk > 0) {
          const livingFoes = enemies.filter(e => e.hp > 0);
          if (livingFoes.length > 0) {
            const tar = livingFoes.sort((a, b) => a.hp - b.hp)[0];
            const atkVal = (frey.attrs ? frey.attrs.mag_atk : (frey.mag_atk || 100));
            const defVal = (tar.attrs ? tar.attrs.mag_def : (tar.mag_def || 100));
            const strikeDmg = Math.max(1, Math.round(((Number(frey.level) || 1) + 5) / 50 * (atkVal * higherAtk * 20) / Math.max(1, defVal)));
            tar.hp = Math.max(0, tar.hp - strikeDmg);
            effects.push({
              trigger_count: 0,
              atk_servant_id: frey.id,
              src_servant_id: frey.id,
              tar_servant_ids: [tar.id],
              src_type: 1,
              src_id: 22130,
              id: 22131, // 官方挥剑展示条目（act=20500）；22130 是 name-only 条目=客户端静默无演出
              effect_phase: 7,
              change_type: 200000,
              change_value: [-strikeDmg],
              remove_round: 0,
            });
          }
        }
      });
    }
  });

  // 雅典娜（21530 百战圣女）：恢复2层圣盾，生效下回合增伤
  (units || []).forEach(u => {
    if (u && u.hp > 0 && u.talent === 21530) {
      u.athenaShields = 2;
      u.athenaDmgBoostCurr = u.athenaDmgBoostNext || 0;
      u.athenaDmgBoostNext = 0;
    }
  });

  // 德墨忒尔（21250 丰饶之祈）：生效下回合增伤
  (units || []).forEach(u => {
    if (u && u.hp > 0 && u.talent === 21250) {
      u.demeterCurrDmg = u.demeterNextDmg || 0;
      u.demeterNextDmg = 0;
    }
  });

  // 奥西里斯（20930 冥界归还）：力尽结算与增伤生效
  (units || []).forEach(u => {
    if (u && u.pendingFaint) {
      u.hp = 0;
      u.pendingFaint = false;
      if (u.osirisSavedBy) {
        const osiris = (units || []).find(x => x && x.id === u.osirisSavedBy && x.hp > 0);
        if (osiris) {
          osiris.osirisNextDmg = (osiris.osirisNextDmg || 0) + 0.75;
        }
      }
    }
  });
  (units || []).forEach(u => {
    if (u && u.hp > 0 && u.talent === 20930) {
      u.osirisCurrDmg = u.osirisNextDmg || 0;
      u.osirisNextDmg = 0;
    }
  });

  // 65. 耶梦加得（21430 尘世巨蟒）：带有巨蟒之毒者，回合结束时结算扣血
  (units || []).forEach(u => {
    if (!u || u.hp <= 0 || !u.midgardPoison) return;
    const maxHp = Number(u.maxHp || (u.attrs && u.attrs.hp) || u.hp) || 1000;
    const ratio = (u.hp / maxHp >= 0.50) ? 0.07 : 0.14;
    const poisonDmg = Math.max(1, Math.round(maxHp * ratio));
    u.hp = Math.max(0, u.hp - poisonDmg);
    u.midgardPoison = false;
    effects.push({
      trigger_count: 0,
      atk_servant_id: u.id,
      src_servant_id: u.id,
      tar_servant_ids: [u.id],
      src_type: 1,
      src_id: 21430,
      id: 21430,
      effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
      change_type: 200000,
      change_value: [-poisonDmg],
      remove_round: 0,
    });
  });

  // 深渊狱火（10322）：被命中目标与施放者每回合损失20%最大生命（hellfireRounds 由技能命中时标记）
  (units || []).forEach(u => {
    if (!u || !u.hellfireRounds || u.hellfireRounds <= 0) return;
    u.hellfireRounds--;
    if (u.hp > 0) {
      const maxHp = Number(u.maxHp || (u.attrs && u.attrs.hp) || u.hp) || 1000;
      const fireDmg = Math.max(1, Math.round(maxHp * 0.20));
      u.hp = Math.max(0, u.hp - fireDmg);
      effects.push({
        trigger_count: 0,
        atk_servant_id: u.id,
        src_servant_id: u.id,
        tar_servant_ids: [u.id],
        src_type: 1,
        src_id: 10322,
        id: 10322,
        effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
        change_type: 200000,
        change_value: [-fireDmg],
        remove_round: 0,
      });
    }
  });

  // 66. 海拉（21210 冥界侍从）：回合结束时，己方随机1名其他暗属性誓灵1项能力上升1级
  const helList = (units || []).filter(u => u && u.hp > 0 && u.talent === 21210);
  helList.forEach(hel => {
    const darkAllies = (units || []).filter(a => a && a.hp > 0 && a.side === hel.side && a.id !== hel.id && natureOf(a.type) === 6);
    if (darkAllies.length > 0) {
      const tar = darkAllies[Math.floor(Math.random() * darkAllies.length)];
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(Math.random() * props.length)];
      tar.statLevels = tar.statLevels || {};
      const oldLv = tar.statLevels[p] || 0;
      const newLv = Math.min(6, oldLv + 1);
      const delta = newLv - oldLv;
      tar.statLevels[p] = newLv;
      const aN = PROP_ATTR_NAMES[p];
      if (aN) tar[aN] = newLv;
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: hel.id,
          src_servant_id: hel.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 21210,
          id: 21210,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(p, delta, newLv)],
          remove_round: 0,
        });
      }
    }
  });

  // 67. 尼德霍格（22110 绝望的具象）：每回合结束时，将敌方某项能力的最低等级同步至敌方全体，并扣除负面总等级*4%的当前生命
  const nidhoggList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22110);
  nidhoggList.forEach(nidhogg => {
    const enemies = (units || []).filter(e => e && e.hp > 0 && e.side !== nidhogg.side);
    if (enemies.length === 0) return;
    const props = [101, 102, 103, 104, 105, 111, 113, 115];
    props.forEach(p => {
      let minLv = 0;
      enemies.forEach(e => {
        const lv = (e.statLevels && e.statLevels[p]) || 0;
        if (lv < minLv) minLv = lv;
      });
      if (minLv < 0) {
        enemies.forEach(e => {
          const curLv = (e.statLevels && e.statLevels[p]) || 0;
          if (curLv > minLv) {
            gainStat(e, p, minLv - curLv, { effects, srcId: 22110, atkId: nidhogg.id, srcServantId: nidhogg.id, phase: 7 });
          }
        });
      }
    });

    // 扣除自身负面总等级 * 4% 当前生命
    enemies.forEach(e => {
      if (e.hp <= 0) return;
      let totalNeg = 0;
      props.forEach(p => {
        const lv = (e.statLevels && e.statLevels[p]) || 0;
        if (lv < 0) totalNeg += Math.abs(lv);
      });
      if (totalNeg > 0) {
        const dmg = Math.max(1, Math.round(e.hp * (totalNeg * 0.04)));
        e.hp = Math.max(0, e.hp - dmg);
        effects.push({
          trigger_count: 0,
          atk_servant_id: nidhogg.id,
          src_servant_id: nidhogg.id,
          tar_servant_ids: [e.id],
          src_type: 1,
          src_id: 22110,
          id: 22110,
          effect_phase: 7,
          change_type: 200000,
          change_value: [-dmg],
          remove_round: 0,
        });
      }
    });
  });

  // 87. 达格达（22640 生死轮回）：本回合内每当有角色被击败、恢复生命、因效果扣除生命，回合结束自身随机提升1项能力等级且获得5%护盾
  const dagdaList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22640);
  if (dagdaList.length > 0 && battleState && battleState.samsaraEvents > 0) {
    dagdaList.forEach(dagda => {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const maxHp = Number(dagda.maxHp || (dagda.attrs && dagda.attrs.hp) || dagda.hp) || 1000;
      const shieldVal = Math.max(1, Math.round(maxHp * 0.05));
      dagda.shield = (Number(dagda.shield) || 0) + shieldVal;

      const p = props[Math.floor(Math.random() * props.length)];
      dagda.statLevels = dagda.statLevels || {};
      const oldLv = dagda.statLevels[p] || 0;
      const newLv = Math.min(6, oldLv + 1);
      const delta = newLv - oldLv;
      dagda.statLevels[p] = newLv;
      const aN = PROP_ATTR_NAMES[p];
      if (aN) dagda[aN] = newLv;

      effects.push({
        trigger_count: 0,
        atk_servant_id: dagda.id,
        src_servant_id: dagda.id,
        tar_servant_ids: [dagda.id],
        src_type: 1,
        src_id: 22640,
        id: 22640,
        effect_phase: 7,
        change_type: 200001,
        change_value: [shieldVal],
        remove_round: 0,
      });
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: dagda.id,
          src_servant_id: dagda.id,
          tar_servant_ids: [dagda.id],
          src_type: 1,
          src_id: 22640,
          id: 22640,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(p, delta, newLv)],
          remove_round: 0,
        });
      }
    });
    battleState.samsaraEvents = 0;
  }

  // 89. 高朱蒙（21870 东明圣王）：回合结束时清除自身负面能力等级，每清除1级提升下回合10%伤害
  (units || []).forEach(u => {
    if (!u || u.hp <= 0 || u.talent !== 21870) return;
    const props = [101, 102, 103, 104, 105, 111, 113, 115];
    let clearedCount = 0;
    const changes = [];
    props.forEach(p => {
      const lv = (u.statLevels && u.statLevels[p]) || 0;
      if (lv < 0) {
        clearedCount += Math.abs(lv);
        u.statLevels[p] = 0;
        const aN = PROP_ATTR_NAMES[p];
        if (aN) u[aN] = 0;
        changes.push(encodeAttrVal(p, Math.abs(lv), 0));
      }
    });
    if (clearedCount > 0) {
      u.nextDmgBonus = Math.round(((u.nextDmgBonus || 0) + (clearedCount * 0.10)) * 100) / 100;
      effects.push({
        trigger_count: 0,
        atk_servant_id: u.id,
        src_servant_id: u.id,
        tar_servant_ids: [u.id],
        src_type: 1,
        src_id: 21870,
        id: 21870,
        effect_phase: 7,
        change_type: 100000,
        change_value: changes,
        remove_round: 0,
      });
    }
  });

  // 90. 伐楼那（22220 天海波流）：二回合内敌方攻击过己方水系誓灵，回合结束损失该水系誓灵最大生命15%
  const varunaList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22220);
  varunaList.forEach(varuna => {
    const enemies = (units || []).filter(e => e && e.hp > 0 && e.side !== varuna.side);
    enemies.forEach(e => {
      if (e.attackedWaterAllies && e.attackedWaterAllies.length > 0) {
        let totalRetaliateDmg = 0;
        e.attackedWaterAllies.forEach(rec => {
          if (rec.rounds > 0) {
            totalRetaliateDmg += Math.max(1, Math.round(rec.maxHp * 0.15));
            rec.rounds -= 1;
          }
        });
        e.attackedWaterAllies = e.attackedWaterAllies.filter(rec => rec.rounds > 0);
        if (totalRetaliateDmg > 0) {
          e.hp = Math.max(0, e.hp - totalRetaliateDmg);
          effects.push({
            trigger_count: 0,
            atk_servant_id: varuna.id,
            src_servant_id: varuna.id,
            tar_servant_ids: [e.id],
            src_type: 1,
            src_id: 22220,
            id: 22220,
            effect_phase: 7,
            change_type: 200000,
            change_value: [-totalRetaliateDmg],
            remove_round: 0,
          });
        }
      }
    });
  });

  // 95. 薇薇安（20610 反复无常）：回合结束时，会使自身之外的随机一个誓灵发生特殊事件
  const vivianList = (units || []).filter(u => u && u.hp > 0 && u.talent === 20610);
  vivianList.forEach(vivian => {
    const candidates = (units || []).filter(tar => tar && tar.hp > 0 && tar.id !== vivian.id);
    if (candidates.length > 0) {
      const tar = candidates[Math.floor(Math.random() * candidates.length)];
      const eventType = Math.floor(Math.random() * 3);
      if (eventType === 0) {
        // 206101: 关进幽闭塔（退缩）
        applyFlinch(tar, effects, 7, 206101, vivian.id);
        effects.push({
          trigger_count: 0,
          atk_servant_id: vivian.id,
          src_servant_id: vivian.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 206101,
          id: 206101,
          effect_phase: 7,
          change_type: 0,
          change_value: [],
          remove_round: 0,
        });
      } else if (eventType === 1) {
        // 206102: 属性被变成了 #value 属性
        const nats = [1, 2, 3, 4, 5, 6];
        const newNat = nats[Math.floor(Math.random() * nats.length)];
        tar.customNature = newNat;
        tar.nature = newNat;
        effects.push({
          trigger_count: 0,
          atk_servant_id: vivian.id,
          src_servant_id: vivian.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 206102,
          id: 206102,
          effect_phase: 7,
          change_type: 0,
          change_value: [newNat],
          remove_round: 0,
        });
      } else {
        // 206103: 赋予坚定的决心（随机两项能力等级 +2）
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const shuffled = props.slice().sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, 2);
        tar.statLevels = tar.statLevels || {};
        const chgVals = [];
        picked.forEach(p => {
          const oldLv = tar.statLevels[p] || 0;
          const newLv = Math.min(6, oldLv + 2);
          const delta = newLv - oldLv;
          tar.statLevels[p] = newLv;
          const aN = PROP_ATTR_NAMES[p];
          if (aN) tar[aN] = newLv;
          if (delta > 0) chgVals.push(encodeAttrVal(p, delta, newLv));
        });
        if (chgVals.length > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: vivian.id,
            src_servant_id: vivian.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 206103,
            id: 206103,
            effect_phase: 7,
            change_type: 100000,
            change_value: chgVals,
            remove_round: 0,
          });
        }
      }
    }
  });

  // 结转下回合通用增伤（高朱蒙 21870、盖布 21170 等）
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;
    u.currDmgBonus = u.nextDmgBonus || 0;
    u.nextDmgBonus = 0;
  });

  // =========================================================================
  // SR 阶段一（Phase 1）回合末周期处理
  // =========================================================================
  // 玛门（21770 欲之掌控者）：回合结束时，若敌方誓灵能力等级总和＞6，每多一级造成5%最大HP的伤害
  const mammonList = (units || []).filter(u => u && u.hp > 0 && u.talent === 21770);
  mammonList.forEach(mammon => {
    const foes = (units || []).filter(u => u && u.hp > 0 && u.side !== mammon.side);
    foes.forEach(foe => {
      let positiveSum = 0;
      if (foe.statLevels) {
        Object.values(foe.statLevels).forEach(lv => {
          if (lv > 0) positiveSum += lv;
        });
      }
      if (positiveSum > 6) {
        const excess = positiveSum - 6;
        const hurtVal = Math.max(1, Math.round(foe.maxHp * 0.05 * excess));
        foe.hp = Math.max(1, foe.hp - hurtVal);
        effects.push({
          trigger_count: 0,
          atk_servant_id: mammon.id,
          src_servant_id: mammon.id,
          tar_servant_ids: [foe.id],
          src_type: 1,
          src_id: 21770,
          id: 21770,
          effect_phase: 7,
          change_type: 200000,
          change_value: [-hurtVal],
          remove_round: 0,
        });
      }
    });
  });

  // 席兹（21380 天翔之心）：计算本回合己方队伍能力总等级净增量，若>=1，下回合获得15%*增量伤害加成
  const xiziList = (units || []).filter(u => u && u.hp > 0 && u.talent === 21380);
  xiziList.forEach(xizi => {
    let teamDelta = 0;
    (units || []).forEach(u => {
      if (u && u.hp > 0 && u.side === xizi.side && u.statLevels) {
        Object.values(u.statLevels).forEach(lv => {
          if (lv > 0) teamDelta += lv;
        });
      }
    });
    if (teamDelta >= 1) {
      xizi.xiziNextDmgBoost = 0.15 * teamDelta;
    } else {
      xizi.xiziNextDmgBoost = 0;
    }
  });

  // 寅（22010 如虎添翼）：若自身速度非全场最高，回合结束时提升1级速度
  const yinList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22010);
  yinList.forEach(yin => {
    const allSpeeds = (units || []).filter(u => u && u.hp > 0).map(u => effectiveSpeed(u, units, battleState));
    const maxSpd = Math.max(...allSpeeds);
    const mySpd = effectiveSpeed(yin, units, battleState);
    if (mySpd < maxSpd) {
      const delta = gainStat(yin, 105, 1, { effects, srcId: yin.talent || 22010, atkId: yin.id, srcServantId: yin.id, phase: 7 });
      const newSpd = (yin.statLevels && yin.statLevels[105]) || 0;
      const an = PROP_ATTR_NAMES[105];
      if (an) yin[an] = newSpd;
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: yin.id,
          src_servant_id: yin.id,
          tar_servant_ids: [yin.id],
          src_type: 1,
          src_id: 22010,
          id: 22010,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(105, delta, newSpd)],
          remove_round: 0,
        });
      }
    }
  });

  // =========================================================================
  // SR 阶段六（Phase 6）回合末终局处理
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 118. 摩伽罗（22520 圆融境界）：记录本回合攻击/防御下降级数供下回合转换
    if (u.talent === 22520) {
      u.statLevels = u.statLevels || {};
      const atkDown = Math.max(0, -(u.statLevels[101] || 0)) + Math.max(0, -(u.statLevels[102] || 0));
      const defDown = Math.max(0, -(u.statLevels[103] || 0)) + Math.max(0, -(u.statLevels[104] || 0));
      u.makaraAtkDownLast = atkDown;
      u.makaraDefDownLast = defDown;
    }

    // 116. 持国天（22280 中道之琴）：减伤持续回合递减
    if (u.dhrtarastraMitRounds > 0) u.dhrtarastraMitRounds--;
    // 110. 伊塔库亚（21920 风行者之路）：风系减伤标记回合末清除
    u.itaquaWindUsed = false;
    // 鹿蜀十字易伤回合末清除
    u.lushuCrossVuln = 0;
    // 增长天暴击叠层回合末减半（临时性质）
    if (u.virudhakaHitStacks > 0) u.virudhakaHitStacks = Math.floor(u.virudhakaHitStacks / 2);
  });

  // =========================================================================
  // SR 阶段五（Phase 5）回合末阵营生态处理
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 90. 白羊座（21070 粗心的金羊）：回合末提升随机1名敌人1级负能力，己方随机2名提升1~2级该能力
    if (u.talent === 21070) {
      const foes = (units || []).filter(f => f && f.hp > 0 && f.side !== u.side);
      if (foes.length > 0) {
        const tar = foes[Math.floor(Math.random() * foes.length)];
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(Math.random() * props.length)];
        tar.statLevels = tar.statLevels || {};
        tar.statLevels[p] = Math.max(-6, (tar.statLevels[p] || 0) - 1);
        const fan = PROP_ATTR_NAMES[p];
        if (fan) tar[fan] = tar.statLevels[p];
        const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
        const chosen = allies.slice().sort(() => Math.random() - 0.5).slice(0, 2);
        const allyGains = [];
        chosen.forEach(a => {
          const boost = 1 + Math.floor(Math.random() * 2);
          a.statLevels = a.statLevels || {};
          const aOld = Number(a.statLevels[p]) || 0;
          const aNew = Math.min(6, aOld + boost);
          const aDelta = aNew - aOld;
          a.statLevels[p] = aNew;
          const an = PROP_ATTR_NAMES[p];
          if (an) a[an] = aNew;
          if (aDelta > 0) allyGains.push({ id: a.id, delta: aDelta });
        });
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 21070,
          id: 21070,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(p, -1, tar.statLevels[p])],
          remove_round: 0,
        });
        // 己方那 2 人的加成原先没有任何事件 —— 玩家只看到敌人掉等级
        allyGains.forEach(g => effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [g.id],
          src_type: 1,
          src_id: 21070,
          id: PROP_FEATURE_IDS[p] || 20001,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(p, g.delta)],
          remove_round: 0,
        }));
      }
    }

    // 99. 子（21990 通灵）：回合末随机增加1级能力（被击败誓灵数上限5名）
    if (u.talent === 21990 && (u.ziDefeatedCount || 0) > 0 && (u.ziDefeatedCount || 0) <= 5) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(Math.random() * props.length)];
      gainStat(u, p, 1, { effects, srcId: 21990, atkId: u.id, srcServantId: u.id, phase: 7 });
    }

    // 104. 亥（22100 滂沱）：回合末给自身添加本回合损失生命值40%的护盾
    // 2026-10-27：原先推 change_type=200000（HP 通道），客户端把正值当回血播放并虚增血条
    // （FeatureLoop.lua:321 正值=加血）；护盾必须走 200001。id 改官方演出条目 22101（act 20505）。
    if (u.talent === 22100) {
      const lost = (u.haiRoundStartHp != null) ? (u.haiRoundStartHp - u.hp) : 0;
      if (lost > 0) {
        const shieldVal = Math.max(1, Math.round(lost * 0.40));
        u.shield = (Number(u.shield) || 0) + shieldVal;
        effects.push(featureFxEffect(u, 22100, 22101, 200001, [shieldVal], [u.id], 7));
      }
      u.haiRoundStartHp = u.hp;
    }

    // 水瓶座增伤持续回合递减
    if (u.aquariusRounds > 0) {
      u.aquariusRounds--;
      if (u.aquariusRounds <= 0) u.aquariusDmgBonus = 0;
    }
    // 小舟酱增伤每回合重掷（回合初处理）
  });

  // =========================================================================
  // SR 阶段四（Phase 4）回合末重置
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;
    // 75. 嫦娥（21300 长生之愿）：同回合受击计数清零
    u.hitsThisRound = 0;
    // 71. 狼人（20870 野性克制）：受击计数不清零（每2次判定）
  });

  // =========================================================================
  // SR 阶段三（Phase 3）回合末周期处理
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 48. 乙姬（21150 驻龄的玉匣）：回合末己方生命低于30%的誓灵回复10%生命且随机1项能力+1
    if (u.talent === 21150) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && (a.hp / a.maxHp) < 0.30);
      allies.forEach(a => {
        const heal = Math.max(1, Math.round(a.maxHp * 0.10));
        a.hp = Math.min(a.maxHp, a.hp + heal);
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(Math.random() * props.length)];
        gainStat(a, p, 1, { effects, srcId: 21150, atkId: u.id, srcServantId: u.id, phase: 7 });
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [a.id],
          src_type: 1,
          src_id: 21150,
          id: 21150,
          effect_phase: 7,
          change_type: 200000,
          change_value: [heal],
          remove_round: 0,
        });
      });
    }

    // 49. 塞勒凯特（21180 蝎之加护）：在场时己方中毒誓灵回合末回复15%生命且随机1项能力+1
    if (u.talent === 21180) {
      const poisoned = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.buffs && a.buffs[BUFF_IDS.POISON]);
      poisoned.forEach(a => {
        const heal = Math.max(1, Math.round(a.maxHp * 0.15));
        a.hp = Math.min(a.maxHp, a.hp + heal);
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(Math.random() * props.length)];
        gainStat(a, p, 1, { effects, srcId: 21180, atkId: u.id, srcServantId: u.id, phase: 7 });
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [a.id],
          src_type: 1,
          src_id: 21180,
          id: 21180,
          effect_phase: 7,
          change_type: 200000,
          change_value: [heal],
          remove_round: 0,
        });
      });
    }

    // 51. 狼人-月夜（21370 狂怒解放）：回合末物攻速度上升1~2级，双防下降1级
    if (u.talent === 21370) {
      const up = 1 + Math.floor(Math.random() * 2);
      u.statLevels = u.statLevels || {};
      [101, 105].forEach(p => {
        u.statLevels[p] = Math.min(6, (u.statLevels[p] || 0) + up);
        const an = PROP_ATTR_NAMES[p];
        if (an) u[an] = u.statLevels[p];
      });
      [103, 104].forEach(p => {
        u.statLevels[p] = Math.max(-6, (u.statLevels[p] || 0) - 1);
        const an = PROP_ATTR_NAMES[p];
        if (an) u[an] = u.statLevels[p];
      });
      // 每项升降各发一条 100000 属性 effect（20001/20005 上、20003/20004 下）——
      // 官方展示：act（升）与 act2（降）由 change_value 符号位选择，只发攻一条玩家看不到
      // 速度/双防变化（2026-10-12「被动没效果」反馈实证）
      [[101, up], [105, up], [103, -1], [104, -1]].forEach(([p, d]) => {
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1,
          src_id: 21370,
          id: PROP_FEATURE_IDS[p] || 20001,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(p, d)],
          remove_round: 0,
        });
      });
    }

    // 50. 白泽（21260 趋吉避凶）：回合末任意一项能力为负的己方誓灵，随机1项能力提升2级
    if (u.talent === 21260) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.statLevels &&
        Object.values(a.statLevels).some(lv => lv < 0));
      allies.forEach(a => {
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(Math.random() * props.length)];
        gainStat(a, p, 2, { effects, srcId: 21260, atkId: u.id, srcServantId: u.id, phase: 7 });
      });
    }

    // —— 批次A回合末族（二百五十一）——
    // 夸父（20420 无尽追逐）：回合结束时，速度提升1级
    if (u.talent === 20420) {
      gainStat(u, 105, 1, { effects, srcId: 20420, atkId: u.id, srcServantId: u.id, phase: 7 });
    }
    // 海德伦族（20710 蜜乳之酒）：回合结束时，自身之外随机1名受伤队友回复最大HP的10%
    if (u.talent === 20710) {
      const injured = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id && a.hp < (a.maxHp || a.hp));
      if (injured.length > 0) {
        const pick = injured[Math.floor(Math.random() * injured.length)];
        const heal = Math.max(1, Math.floor((pick.maxHp || (pick.attrs && pick.attrs.hp) || pick.hp) * 0.10));
        pick.hp = Math.min(pick.maxHp, pick.hp + heal);
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [pick.id],
          src_type: 1, src_id: 20710, id: 20710, effect_phase: 7,
          change_type: 200000, change_value: [heal], remove_round: 0,
        });
      }
    }
    // 蛟（20780 不稳定进化）：回合结束时，随机1项能力提升2级，随机1项能力下降1级（两项独立掷取）
    if (u.talent === 20780) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const pUp = props[Math.floor(Math.random() * props.length)];
      const pDown = props[Math.floor(Math.random() * props.length)];
      gainStat(u, pUp, 2, { effects, srcId: 20780, atkId: u.id, srcServantId: u.id, phase: 7 });
      gainStat(u, pDown, -1, { effects, srcId: 20780, atkId: u.id, srcServantId: u.id, phase: 7 });
    }
    // 贝斯特（20970 芬芳之守护）：回合结束50%几率解除己方1名誓灵的异常状态，被解除者下回合不会进入异常状态
    if (u.talent === 20970 && Math.random() < 0.5) {
      const ABNORMAL_IDS = [50001, 50002, 50003, 50004, 50005, 50006, 50007, 50008];
      const afflicted = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.buffs &&
        ABNORMAL_IDS.some(id => a.buffs[id]));
      if (afflicted.length > 0) {
        const pick = afflicted[Math.floor(Math.random() * afflicted.length)];
        const cleared = ABNORMAL_IDS.filter(id => pick.buffs[id]);
        cleared.forEach(id => { delete pick.buffs[id]; });
        pick.noAbnormalRounds = 1;
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [pick.id],
          src_type: 1, src_id: 20970, id: 20970, effect_phase: 7,
          change_type: 0, change_value: [], remove_round: 0,
        });
      }
    }
    // 猫又（21480 魔力盗取·回合末段）：若自身魔攻等级大于偷取目标，归还1级并对其造成最大生命6%伤害
    if (u.talent === 21480 && u.manaStealTargetId != null) {
      const victim = (units || []).find(x => x && x.hp > 0 && Number(x.id) === Number(u.manaStealTargetId));
      u.manaStealTargetId = null;
      if (victim) {
        const myLv = (u.statLevels && u.statLevels[102]) || 0;
        const foeLv = (victim.statLevels && victim.statLevels[102]) || 0;
        if (myLv > foeLv) {
          gainStat(u, 102, -1, { effects, srcId: 21480, atkId: u.id, srcServantId: u.id, phase: 7 });
          gainStat(victim, 102, 1, { effects, srcId: 21480, atkId: u.id, srcServantId: victim.id, phase: 7 });
          const dmg = Math.max(1, Math.floor((victim.maxHp || (victim.attrs && victim.attrs.hp) || 1) * 0.06));
          victim.hp = Math.max(0, victim.hp - dmg);
          effects.push({
            trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [victim.id],
            src_type: 1, src_id: 21480, id: 21480, effect_phase: 7,
            change_type: 200000, change_value: [-dmg], remove_round: 0,
          });
        }
      }
    }
    // 塔沃里特（21610 诞生守护）：回合结束时与己方生命百分比最低的誓灵（其他者）交换生命百分比，被交换者回复5%
    if (u.talent === 21610) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      if (allies.length > 0) {
        const lowest = allies.slice().sort((a, b) =>
          (a.hp / (a.maxHp || 1)) - (b.hp / (b.maxHp || 1)))[0];
        const myRatio = u.hp / (u.maxHp || 1);
        const theirRatio = lowest.hp / (lowest.maxHp || 1);
        if (theirRatio < myRatio) {
          const myOld = u.hp, theirOld = lowest.hp;
          u.hp = Math.max(1, Math.min(u.maxHp, Math.round(theirRatio * u.maxHp)));
          lowest.hp = Math.min(lowest.maxHp, Math.max(1, Math.round(myRatio * lowest.maxHp)) + Math.max(1, Math.floor((lowest.maxHp || 1) * 0.05)));
          [[u, u.hp - myOld], [lowest, lowest.hp - theirOld]].forEach(([unit2, delta]) => {
            if (delta !== 0) {
              effects.push({
                trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [unit2.id],
                src_type: 1, src_id: 21610, id: 21610, effect_phase: 7,
                change_type: 200000, change_value: [delta], remove_round: 0,
              });
            }
          });
        }
      }
    }

    // 58. 凤凰-稚羽（21600 雏凤之姿）：回合末所有能力等级上升一级直至与场上最高等级看齐
    if (u.talent === 21600) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      u.statLevels = u.statLevels || {};
      props.forEach(p => {
        let maxLv = u.statLevels[p] || 0;
        (units || []).forEach(x => {
          if (x && x.hp > 0 && x.statLevels && (x.statLevels[p] != null)) {
            if (x.statLevels[p] > maxLv) maxLv = x.statLevels[p];
          }
        });
        if ((u.statLevels[p] || 0) < maxLv) {
          gainStat(u, p, 1, { effects, srcId: 21600, atkId: u.id, srcServantId: u.id, phase: 7 });
        }
      });
    }

    // 61. 格欧费茵（22690 一日之境）：回合末己方随机一名角色正向能力+1、负向能力-1
    if (u.talent === 22690) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      if (allies.length > 0) {
        const chosen = allies[Math.floor(Math.random() * allies.length)];
        chosen.statLevels = chosen.statLevels || {};
        Object.keys(chosen.statLevels).forEach(key => {
          const p = Number(key);
          if (!p) return;
          const lv = chosen.statLevels[p] || 0;
          if (lv > 0) gainStat(chosen, p, 1, { effects, srcId: 22690, atkId: u.id, srcServantId: u.id, phase: 7 });
          else if (lv < 0) gainStat(chosen, p, -1, { effects, srcId: 22690, atkId: u.id, srcServantId: u.id, phase: 7 });
        });
      }
    }

    // 62. 座敷童子（22700 地缚灵之赐）：回合末基于己方誓灵稀有度给予不同增益
    if (u.talent === 22700) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      allies.forEach(a => {
        const rarity = Math.floor(Number(a.type) / 10000) % 10;
        const boost = (rarity === 4) ? 2 : (rarity === 3 ? 1 : 0);
        if (boost > 0) {
          const props = [101, 102, 103, 104, 105];
          const p = props[Math.floor(Math.random() * props.length)];
          gainStat(a, p, boost, { effects, srcId: 22700, atkId: u.id, srcServantId: u.id, phase: 7 });
        }
      });
    }

    // 45. 玉藻前（20650 杀生石）：被感染者每回合结束时随机1项能力下降1级
    if (u.infectedByTamamo) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(Math.random() * props.length)];
      u.statLevels = u.statLevels || {};
      const oldLv = u.statLevels[p] || 0;
      const newLv = Math.max(-6, oldLv - 1);
      const delta = newLv - oldLv;
      u.statLevels[p] = newLv;
      const an = PROP_ATTR_NAMES[p];
      if (an) u[an] = newLv;
      if (delta < 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1,
          src_id: 20650,
          id: 20650,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(p, delta, newLv)],
          remove_round: 0,
        });
      }
    }

    // 47. 诗寇蒂（20860 命运·未来）：下回合结束时对敌方全体造成上回合自身伤害18%的伤害
    if (u.talent === 20860) {
      if (u.skuldPendingDamage > 0) {
        const foes = (units || []).filter(f => f && f.hp > 0 && f.side !== u.side);
        foes.forEach(f => {
          const dmg = Math.max(1, Math.round(u.skuldPendingDamage * 0.18));
          f.hp = Math.max(1, f.hp - dmg);
          effects.push({
            trigger_count: 0,
            atk_servant_id: u.id,
            src_servant_id: u.id,
            tar_servant_ids: [f.id],
            src_type: 1,
            src_id: 20860,
            id: 20860,
            effect_phase: 7,
            change_type: 200000,
            change_value: [-dmg],
            remove_round: 0,
          });
        });
        u.skuldPendingDamage = 0;
      }
      if (u.skuldDealtThisRound > 0) {
        u.skuldPendingDamage = u.skuldDealtThisRound;
        u.skuldDealtThisRound = 0;
      }
    }

    // 60. 八上比卖（22620 侧室的幽怨）：回合末消耗2层哀叹并降低随机1级攻击等级
    if (u.talent === 22620) {
      const foes = (units || []).filter(f => f && f.hp > 0 && f.side !== u.side && (f.lamentStacks || 0) >= 2);
      foes.forEach(f => {
        f.lamentStacks -= 2;
        const p = Math.random() < 0.5 ? 101 : 102;
        f.statLevels = f.statLevels || {};
        const oldLv = f.statLevels[p] || 0;
        const newLv = Math.max(-6, oldLv - 1);
        const delta = newLv - oldLv;
        f.statLevels[p] = newLv;
        const an = PROP_ATTR_NAMES[p];
        if (an) f[an] = newLv;
        if (delta < 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: u.id,
            src_servant_id: u.id,
            tar_servant_ids: [f.id],
            src_type: 1,
            src_id: 22620,
            id: 22620,
            effect_phase: 7,
            change_type: 100000,
            change_value: [encodeAttrVal(p, delta, newLv)],
            remove_round: 0,
          });
        }
      });
    }

    // 54. 密米尔（21440 智慧流转）：回合末魔攻等级>0时转移1级魔攻给随机己方誓灵
    if (u.talent === 21440 && (u.statLevels && (u.statLevels[102] || 0) > 0)) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side && a.id !== u.id);
      if (allies.length > 0) {
        const tar = allies[Math.floor(Math.random() * allies.length)];
        gainStat(u, 102, -1, { effects, srcId: 21440, atkId: u.id, srcServantId: u.id, phase: 7 });
        gainStat(tar, 102, 1, { effects, srcId: 21440, atkId: u.id, srcServantId: tar.id, phase: 7 });
        const tan = PROP_ATTR_NAMES[102];
        if (tan) tar[tan] = tar.statLevels[102];
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 21440,
          id: 21440,
          effect_phase: 7,
          change_type: 100000,
          change_value: [encodeAttrVal(102, 1, tar.statLevels[102])],
          remove_round: 0,
        });
      }
    }

    // 63. 小红帽（22760 童话之心）：回合末提升随机防御与物理攻击各1级
    if (u.talent === 22760) {
      const defProp = Math.random() < 0.5 ? 103 : 104;
      u.statLevels = u.statLevels || {};
      gainStat(u, defProp, 1, { effects, srcId: 22760, phase: 7 });
      gainStat(u, 101, 1, { effects, srcId: 22760, phase: 7 });
    }

    // 厄洛斯契约到期清理
    if (u.erosContractRounds > 0) {
      u.erosContractRounds--;
      if (u.erosContractRounds <= 0) {
        u.erosContractWith = null;
      }
    }
  });

  // =========================================================================
  // SR 阶段二（Phase 2）回合末周期处理
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;
    // 31. 贝尔芬格（21760 怠之长眠者）：本回合未造成伤害则下回合减伤50%
    u.belphegorNoDmgLastRound = !(u.dealtDamageThisRound === true);
    // 32. 阿斯莫德（21780 爱之恶堕者）：目标下回合降伤标记轮转
    u.asmodeusDmgDownNextRound = false;
    u.dealtDamageThisRound = false;
    u.suryaReflectedThisRound = false;
    // 28. 史尔特尔（21220 灭世之炎）：同回合火攻叠加层数在回合末清零
    if (battleState) {
      battleState['surtrFireStacks_' + u.side] = 0;
    }
  });

  // 拇指姑娘（22770 万花）：每回合结束时随机向己方角色播种1颗生命之种（三百一十三：层数同步下发）
  const thumbelinaList = (units || []).filter(u => u && u.hp > 0 && u.talent === 22770);
  thumbelinaList.forEach(thum => {
    const allies = (units || []).filter(u => u && u.hp > 0 && u.side === thum.side);
    if (allies.length > 0) {
      const chosen = allies[Math.floor(Math.random() * allies.length)];
      chosen.lifeSeeds = Math.min(3, (chosen.lifeSeeds || 0) + 1);
      effects.push({
        trigger_count: 0, atk_servant_id: thum.id, src_servant_id: thum.id, tar_servant_ids: [chosen.id],
        src_type: 1, src_id: 22770, id: 22770, effect_phase: 7, // TRIGGER_TIME_AFTER_ROUND
        change_type: 300019, change_value: [encodeBuffVal(22770, chosen.lifeSeeds)], remove_round: 0,
      });
    }
  });


  // 效果展开：客户端 FeatureLoop.dealFeatureEff 按 **目标下标** 取 change_value[targetIdx]
  //（tools/lua_src/FeatureLoop.lua:465-477；飘字循环 :172-183 同规则）——一条 effect 只带
  //**一个目标**却塞多个 change_value 时，只有第 1 个被应用。服务端内部两项都加了、客户端只
  //看见其中一项，正是 2026-10-17「鲲的被动只提升一级属性」的根因。
  // 统一在出口展开成「单目标 + 单值」：主线/幻梦/塔三个引擎都从这里取 effect_list，只改一处。
  return flattenEffects(effects);
}

// 行动顺序：speed 降序（考虑 speed_lv 与麻痹减速）→ |x| 大（更前排）→ y 小 → id 小（FightMgr.sortSpeed 同规则）
// 官方技能优先度表（批次E 二百五十三）：CfgSkillDetail 无 priority 字段，值取自 fightDesc。
// 「有时可以先手攻击」= 30% 几率 +1（官方概率无配置，自定基线，照 train/feeling 先例）；
// 沧海遗泪恒 -1；百炼之拳上回合被攻击技能伤害 → +1（伤害段同条件 dmgMulIfHitLastRound）。
const SKILL_PRIO_TABLE = {
  10039: { randomPrio: 1, chance: 30 },      // 迅火弹
  10044: { randomPrio: 1, chance: 30 },      // 音速攻击
  10078: { randomPrio: 1, chance: 30 },      // 潜影奇袭
  10258: { prio: -1 },                       // 沧海遗泪
  10321: { prio: -1 },                       // 后见之明
  10179: { condHitLastRound: 1 },            // 百炼之拳
  10007: { prio: 4 },                        // 绝对防御（批次H2：优先度+4，百度百科/官方观察数据，屏障类）
  10004: { prio: 3 },                        // 结界盾（批次H2：优先度+3，BWIKI）
};

// 每回合排序前调用：写 chosenSkillPrio / chosenSkillNature（sortActors 的两个既有读取位此前无人写）。
// 玩家单位用 selMap（select_list 回传），其余走 aiChoose（无随机 ⇒ 与行动时同结果）。
function applySkillPriorities(units, battleState, selMap) {
  (units || []).forEach(u => {
    if (!u) return;
    u.chosenSkillPrio = 0;
    if (!u.hp || u.hp <= 0) { u.chosenSkillNature = null; return; }
    let sid = null;
    const sel = selMap && selMap[u.id];
    if (sel) sid = Number(sel.skillId || sel) || null;
    if (!sid) {
      const ch = aiChoose(u, units);
      if (ch && ch.skillId) sid = Number(ch.skillId);
    }
    if (!sid) { u.chosenSkillNature = null; return; }
    const c = skillCfg(sid);
    u.chosenSkillNature = c ? c.nature : null;
    let prio = 0;
    const pr = SKILL_PRIO_TABLE[sid];
    if (pr) {
      if (pr.condHitLastRound) { if (u.hitByAtkLastRound) prio += 1; }
      else if (pr.prio) prio += pr.prio;
      if (pr.randomPrio && Math.random() * 100 < (pr.chance || 100)) prio += pr.randomPrio;
    }
    // 战鼓之音（10195）标记：目标的声音技 +2 优先度（+20% 伤害在 settleSkill 声音段消费）
    if (u.nextSoundBoost && isSoundSkill(sid)) prio += (u.nextSoundBoost.prio || 0);
    // 彩虹之神使（21590）：自身使用辅助技能优先度+1；众神的馈赠（20300）：己方使用辅助技能优先度+1
    if (c && isSupportSkillCfg(c)) {
      if (u.talent === 21590) prio += 1;
      if ((units || []).some(a => a && a.hp > 0 && a.side === u.side && a.talent === 20300)) prio += 1;
    }
    u.chosenSkillPrio = prio;
  });
}

function sortActors(units, battleState, selMap) {
  const curWeather = (normalizeWeatherState(battleState) || {}).start_weather || WEATHER_IDS.NONE;
  const skillNatureOf = (u) => {
    if (u.chosenSkillNature != null) return u.chosenSkillNature;
    if (selMap && selMap[u.id] && selMap[u.id].skillId) {
      const c = skillCfg(selMap[u.id].skillId);
      if (c) return c.nature;
    }
    if (u.skills && u.skills.length) {
      const c = skillCfg(u.skills[0].id);
      if (c) return c.nature;
    }
    return 0;
  };
  // 疾行轮族：同优先度时按概率抢先。概率必须在排序**前**每单位掷一次（比较器里掷骰不稳定）。
  const relicPriority = new Map();
  units.forEach(u => {
    if (u && u.hp > 0 && u.relicMisc && u.relicMisc.priorityChance > 0 && Math.random() < u.relicMisc.priorityChance) {
      relicPriority.set(u.id, 1);
    }
  });
  return units.filter(u => u.hp > 0).sort((a, b) => {
    const natA = skillNatureOf(a);
    const natB = skillNatureOf(b);
    // 初濑伊纲（21840 超常感知）：敌方攻击意图指向自己 → 优先度+1（意图图=battleState.selMap，值为目标 id）
    const isIzunaTargeted = (u) => {
      if (u.talent !== 21840 || !battleState || !battleState.selMap) return false;
      return Object.values(battleState.selMap).some(tid => Number(tid) === Number(u.id));
    };
    const izunaBonusA = isIzunaTargeted(a) ? 1 : 0;
    const izunaBonusB = isIzunaTargeted(b) ? 1 : 0;
    // 海姆达尔（22120 克敌机先）：物攻能力等级每提升2级，技能优先度+1
    const heimdallBonus = (u) => (u.talent === 22120 ? Math.floor(Math.max(0, (u.statLevels && u.statLevels[101]) || u.phy_atk_lv || 0) / 2) : 0);
    const yinglongBonus = (u) => (u.talent === 22930 && (u.trueDragonLayers || 0) >= 15 ? 2 : 0);
    // 蜜蜡之翼（20290 伊卡洛斯）：乱流天气时技能优先度+1（不分技能属性，与天气自身「风系+1」叠加）
    const ikarosPrioBonus = (u) => (u.talent === 20290 && curWeather === WEATHER_IDS.TURBULENCE ? 1 : 0);
    const curRound = battleState ? battleState.round : 0;
    const pbA = (a.nextPriorityBonus && a.nextPriorityRound === curRound) ? a.nextPriorityBonus : 0;
    const pbB = (b.nextPriorityBonus && b.nextPriorityRound === curRound) ? b.nextPriorityBonus : 0;
    const prioA = (a.chosenSkillPrio || 0) + pbA + izunaBonusA + heimdallBonus(a) + yinglongBonus(a) + ikarosPrioBonus(a) + ((curWeather === WEATHER_IDS.TURBULENCE || a.talent === 20210) && natA === 3 ? 1 : 0);
    const prioB = (b.chosenSkillPrio || 0) + pbB + izunaBonusB + heimdallBonus(b) + yinglongBonus(b) + ikarosPrioBonus(b) + ((curWeather === WEATHER_IDS.TURBULENCE || b.talent === 20210) && natB === 3 ? 1 : 0);
    // 疾行轮族：「在相同优先度时，有N%概率优先使出技能」——
    // 只在 prioA === prioB 时才用抢先标记打破速度序；优先度不同绝不能掺进来。
    if (prioB !== prioA) return prioB - prioA;
    const rpA = relicPriority.get(a.id) || 0;
    const rpB = relicPriority.get(b.id) || 0;
    if (rpB !== rpA) return rpB - rpA;
    const spdA = effectiveSpeed(a, units, battleState), spdB = effectiveSpeed(b, units, battleState);
    if (spdB !== spdA) return spdB - spdA;
    const ax = Math.abs(a.pos ? a.pos[0] : 0), bx = Math.abs(b.pos ? b.pos[0] : 0);
    if (ax !== bx) return bx - ax;
    const ay = a.pos ? a.pos[1] : 0, by = b.pos ? b.pos[1] : 0;
    if (ay !== by) return ay - by;
    return a.id - b.id;
  });
}

// 技能释放后被动天赋触发器（如月读「月之蚀」、天照「日之耀」、洛基「邪神业火」等）
function checkTalentsAfterSkill(actor, cfg, targets, results, allUnits, actIndex, battleState) {
  const effects = [];
  const phase = ((actIndex || 0) * 100) + 4; // TRIGGER_TIME_AFTER_SKILL
  const rnd = Math.random;

  // =========================================================================
  // SR 阶段一（Phase 1）checkTalentsAfterSkill 技能后被动触发
  // =========================================================================
  // 雪女（20160 风雪的隐匿者）：当雪女的技能未命中时，雪女的魔攻、闪避提升1级
  if (actor.talent === 20160 && results && ((Array.isArray(results) && results.some(r => r.isMiss)) || (results.wakeEffects && results.wakeEffects.some(e => e.change_type === 10)))) {
    [102, 113].forEach(prop => {
      actor.statLevels = actor.statLevels || {};
      const oldLv = actor.statLevels[prop] || 0;
      const newLv = Math.min(6, oldLv + 1);
      const delta = newLv - oldLv;
      actor.statLevels[prop] = newLv;
      const an = PROP_ATTR_NAMES[prop];
      if (an) actor[an] = newLv;
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 20160,
          id: 20160,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, delta, newLv)],
          remove_round: 0,
        });
      }
    });
  }

  // 狄俄尼索斯（20220 神秘酒酿）：对己方其他目标使用辅助技能时，随机提升目标一项能力1-2级
  if (actor.talent === 20220 && (Number(cfg.kind) === 3 || cfg.power === 0)) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side === actor.side && tar.id !== actor.id) {
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const prop = props[Math.floor(rnd() * props.length)];
        const boost = 1 + Math.floor(rnd() * 2);
        tar.statLevels = tar.statLevels || {};
        const oldLv = tar.statLevels[prop] || 0;
        const newLv = Math.min(6, oldLv + boost);
        const delta = newLv - oldLv;
        tar.statLevels[prop] = newLv;
        const an = PROP_ATTR_NAMES[prop];
        if (an) tar[an] = newLv;
        if (delta > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 20220,
            id: 20220,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(prop, delta, newLv)],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 喀戎（20600 全知的贤者）：造成克制伤害后使目标随机1项防御下降1级
  if (actor.talent === 20600) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side !== actor.side && natureRelate(cfg.nature, tar.nature) === 1) {
        const prop = rnd() < 0.5 ? 103 : 104;
        tar.statLevels = tar.statLevels || {};
        const oldLv = tar.statLevels[prop] || 0;
        const newLv = Math.max(-6, oldLv - 1);
        const delta = newLv - oldLv;
        tar.statLevels[prop] = newLv;
        const an = PROP_ATTR_NAMES[prop];
        if (an) tar[an] = newLv;
        if (delta < 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 20600,
            id: 20600,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(prop, delta, newLv)],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 巳（22040 灵蛇之珠）：使用水系技能造成伤害后，会对攻击目标造成1次威力为30的单体攻击，且50%概率使对方中毒
  if (actor.talent === 22040 && cfg.nature === 1 && cfg.power > 0) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side !== actor.side) {
        const atkVal = (actor.attrs ? actor.attrs.mag_atk : (actor.mag_atk || 100));
        const defVal = (tar.attrs ? tar.attrs.mag_def : (tar.mag_def || 100));
        // 同主骨架口径：(lv+5)/50 × atk/def × 威力30（灵蛇之珠）
        const chaseDmg = Math.max(1, Math.round(((Number(actor.level) || 1) + 5) / 50 * (atkVal * 30) / Math.max(1, defVal)));
        tar.hp = Math.max(1, tar.hp - chaseDmg);
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 22040,
          id: 22041, // 官方追击展示条目（FightFeature[22041] act=20500 挥剑）；22040 是 name-only 条目=客户端静默无演出（2026-11-07 与弗雷 22131 同族修复）
          effect_phase: phase,
          change_type: 200000,
          change_value: [-chaseDmg],
          remove_round: 0,
        });
        if (rnd() < 0.50) {
          tar.buffs = tar.buffs || {};
          tar.buffs[BUFF_IDS.POISON] = { level: 1, duration: 3 };
          // 三百一十三：原 change_type:0 空 effect（id 90001 还是麻痹生效的错文案）零显示——
          // 换成官方中毒生效 90801 的 ADD_BUFF（与 applyExclusiveBuff 同形态）
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 3,
            src_id: 0,
            id: BUFF_FEATURE_IDS[BUFF_IDS.POISON].apply,
            effect_phase: phase,
            change_type: 300019,
            change_value: [encodeBuffVal(BUFF_IDS.POISON, 1)],
            remove_round: 3,
          });
        }
      }
    });
  }

  // 古尔薇格（22980 战争的起始）：全场角色使用攻击技能后，其余同方角色较高攻击等级+1、暴击率+5%；使用辅助技能后，自身随机防御降低1级
  const gullveigPresent = (allUnits || []).some(u => u && u.hp > 0 && u.talent === 22980);
  if (gullveigPresent) {
    if (cfg.power > 0) {
      const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.id !== actor.id);
      allies.forEach(ally => {
        const prop = (ally.attrs.phy_atk >= ally.attrs.mag_atk) ? 101 : 102;
        ally.statLevels = ally.statLevels || {};
        const oldLv = ally.statLevels[prop] || 0;
        const newLv = Math.min(6, oldLv + 1);
        const delta = newLv - oldLv;
        ally.statLevels[prop] = newLv;
        const an = PROP_ATTR_NAMES[prop];
        if (an) ally[an] = newLv;
        ally.critRateBonus = (ally.critRateBonus || 0) + 0.05;
        if (delta > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: ally.id,
            tar_servant_ids: [ally.id],
            src_type: 1,
            src_id: 22980,
            id: 22980,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(prop, delta, newLv)],
            remove_round: 0,
          });
        }
      });
    } else {
      const prop = rnd() < 0.5 ? 103 : 104;
      actor.statLevels = actor.statLevels || {};
      const oldLv = actor.statLevels[prop] || 0;
      const newLv = Math.max(-6, oldLv - 1);
      const delta = newLv - oldLv;
      actor.statLevels[prop] = newLv;
      const an = PROP_ATTR_NAMES[prop];
      if (an) actor[an] = newLv;
      if (delta < 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 22980,
          id: 22980,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, delta, newLv)],
          remove_round: 0,
        });
      }
    }
  }

  // 独角兽（23020 纯洁之兽）：造成技能伤害后，若效果未被消耗，50%概率提升1级魔攻等级
  if (actor.talent === 23020 && actor.unicornPurifyAvailable && cfg.power > 0 && rnd() < 0.50) {
    gainStat(actor, 102, 1, { effects: wakeEffects, srcId: 23020, atkId: actor.id, srcServantId: actor.id, phase });
  }

    // =========================================================================
  // SR 阶段二（Phase 2）checkTalentsAfterSkill 技能后被动触发
  // =========================================================================
  // 24. 利维坦（20540 嫉妒之心）：己方其他成员能力提升时，自己随机一项能力提升1级
  if ((allUnits || []).some(u => u && u.hp > 0 && u.talent === 20540)) {
    (allUnits || []).filter(u => u && u.hp > 0 && u.talent === 20540).forEach(levi => {
      const allyUp = (allUnits || []).some(a => a && a.hp > 0 && a.side === levi.side && a.id !== levi.id && a.statLevels &&
        Object.values(a.statLevels).some(lv => lv > 0));
      if (allyUp) {
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(rnd() * props.length)];
        levi.statLevels = levi.statLevels || {};
        const oldLv = levi.statLevels[p] || 0;
        const newLv = Math.min(6, oldLv + 1);
        const delta = newLv - oldLv;
        levi.statLevels[p] = newLv;
        const an = PROP_ATTR_NAMES[p];
        if (an) levi[an] = newLv;
        if (delta > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: levi.id,
            tar_servant_ids: [levi.id],
            src_type: 1,
            src_id: 20540,
            id: 20540,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(p, delta, newLv)],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 25. 贝希摩斯（20670 吞噬之心）：敌方誓灵能力下降时，自己随机一项能力提升1级
  if ((allUnits || []).some(u => u && u.hp > 0 && u.talent === 20670)) {
    (allUnits || []).filter(u => u && u.hp > 0 && u.talent === 20670).forEach(behe => {
      const foeDown = (allUnits || []).some(f => f && f.hp > 0 && f.side !== behe.side && f.statLevels &&
        Object.values(f.statLevels).some(lv => lv < 0));
      if (foeDown) {
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(rnd() * props.length)];
        behe.statLevels = behe.statLevels || {};
        const oldLv = behe.statLevels[p] || 0;
        const newLv = Math.min(6, oldLv + 1);
        const delta = newLv - oldLv;
        behe.statLevels[p] = newLv;
        const an = PROP_ATTR_NAMES[p];
        if (an) behe[an] = newLv;
        if (delta > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: behe.id,
            tar_servant_ids: [behe.id],
            src_type: 1,
            src_id: 20670,
            id: 20670,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(p, delta, newLv)],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 29. 阿斯特赖亚（21560 正义星辰）：对能力等级为正的目标造成伤害后，使其随机1项正向能力下降2级
  if (actor.talent === 21560) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side !== actor.side && tar.statLevels) {
        const posProps = Object.keys(tar.statLevels).filter(k => tar.statLevels[k] > 0);
        if (posProps.length > 0) {
          const p = Number(posProps[Math.floor(rnd() * posProps.length)]);
          const oldLv = tar.statLevels[p] || 0;
          const newLv = Math.max(-6, oldLv - 2);
          const delta = newLv - oldLv;
          tar.statLevels[p] = newLv;
          const an = PROP_ATTR_NAMES[p];
          if (an) tar[an] = newLv;
          if (delta < 0) {
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id,
              src_servant_id: actor.id,
              tar_servant_ids: [tar.id],
              src_type: 1,
              src_id: 21560,
              id: 21560,
              effect_phase: phase,
              change_type: 100000,
              change_value: [encodeAttrVal(p, delta, newLv)],
              remove_round: 0,
            });
          }
        }
      }
    });
  }

  // 77. 伊姆霍特普（21620 庇护医者）：对拥有护盾的誓灵使用回复技能，回复量翻倍
  if (actor.talent === 21620 && (Number(cfg.kind) === 3 || isFriendEff(cfg.effType) || cfg.healPct)) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side === actor.side && (Number(tar.shield) || 0) > 0) {
        const extraHeal = Math.max(1, Math.round(tar.maxHp * (cfg.healPct || 10) / 100));
        const after = Math.min(tar.maxHp, tar.hp + extraHeal);
        const gained = after - tar.hp;
        tar.hp = after;
        if (gained > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 21620,
            id: 21620,
            effect_phase: phase,
            change_type: 200000,
            change_value: [gained],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 27. 塞赫美特（21190 嗜血医者）：使用回复技能后，被回复者下次攻击伤害提升30%
  if (actor.talent === 21190 && (Number(cfg.kind) === 3 || isFriendEff(cfg.effType))) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side === actor.side) {
        tar.sekhmetNextAtkBonus = 0.30;
      }
    });
  }

  // =========================================================================
  // SR 阶段三（Phase 3）checkTalentsAfterSkill 技能后环境触发
  // =========================================================================
  // 53. 酒吞童子（21400 大江山之鬼）：造成技能伤害后进入暴怒状态
  if (actor.talent === 21400 && cfg.power > 0) {
    actor.shutenRage = true;
  }

  // 56. 萨提特（21470 洪流圣卫）：场上每使用一次水属性技能获得最大生命4%护盾（暴雨下7%）
  if (cfg.nature === 1 && cfg.power > 0) {
    (allUnits || []).forEach(satet => {
      if (satet && satet.hp > 0 && satet.talent === 21470) {
        const ratio = ((battleState && battleState.weather && battleState.weather.start_weather) === WEATHER_IDS.RAIN) ? 0.07 : 0.04;
        const shieldVal = Math.max(1, Math.round(satet.maxHp * ratio));
        satet.shield = (Number(satet.shield) || 0) + shieldVal;
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: satet.id,
          tar_servant_ids: [satet.id],
          src_type: 1,
          src_id: 21470,
          id: 21470,
          effect_phase: phase,
          // 2026-10-27：护盾必须走 200001（200000 正值客户端当回血播、盾不可见）
          change_type: 200001,
          change_value: [shieldVal],
          remove_round: 0,
        });
      }
    });
  }

  // 57. 珀耳塞福涅（21510 双面冥后）：使用辅助技能后己方誓灵下次伤害提升25%（夜幕50%）
  if (actor.talent === 21510 && (Number(cfg.kind) === 3 || isFriendEff(cfg.effType) || cfg.power === 0)) {
    const isNight = ((battleState && battleState.weather && battleState.weather.start_weather) === WEATHER_IDS.NIGHT);
    const bonus = isNight ? 0.50 : 0.25;
    (allUnits || []).forEach(a => {
      if (a && a.hp > 0 && a.side === actor.side) {
        a.persephoneNextDmgBonus = bonus;
      }
    });
  }

  // =========================================================================
  // SR 阶段五（Phase 5）checkTalentsAfterSkill 阵营生态触发
  // =========================================================================
  // 86. 天蝎座（21020 舍身毒刺）：造成伤害时35%概率使敌方中毒（光属性100%）
  if (actor.talent === 21020) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side !== actor.side) {
        const prob = (tar.nature === 5) ? 1.0 : 0.35;
        if (rnd() < prob) {
          tar.buffs = tar.buffs || {};
          tar.buffs[BUFF_IDS.POISON] = { level: 1, duration: 3 };
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 21020,
            id: 21020,
            effect_phase: phase,
            change_type: 300019,
            change_value: [encodeBuffVal(BUFF_IDS.POISON, 1)],
            remove_round: 3,
          });
        }
      }
    });
  }

  // 85. 天秤座（21010 公正之秤）：己方能力等级总值<=敌方时，己方全体随机1项能力+1
  if (actor.talent === 21010) {
    const sumLv = (side) => {
      let sum = 0;
      (allUnits || []).forEach(u => {
        if (u && u.hp > 0 && u.side === side && u.statLevels) {
          Object.values(u.statLevels).forEach(lv => { sum += (lv || 0); });
        }
      });
      return sum;
    };
    if (sumLv(actor.side) <= sumLv(actor.side === 0 ? 1 : 0)) {
      const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
      allies.forEach(a => {
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(rnd() * props.length)];
        a.statLevels = a.statLevels || {};
        a.statLevels[p] = Math.min(6, (a.statLevels[p] || 0) + 1);
        const an = PROP_ATTR_NAMES[p];
        if (an) a[an] = a.statLevels[p];
      });
      effects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: allies.map(a => a.id),
        src_type: 1,
        src_id: 21010,
        id: 21010,
        effect_phase: phase,
        change_type: 100000,
        change_value: [],
        remove_round: 0,
      });
    }
  }

  // 88. 水瓶座（21050 神侍）：水系辅助技能使目标回血10%且增伤15%持续2回合；风系技能己方随机1名速度+1
  if (actor.talent === 21050) {
    if (cfg.nature === 1 && (Number(cfg.kind) === 3 || isFriendEff(cfg.effType))) {
      (targets || []).forEach(tar => {
        if (tar && tar.hp > 0 && tar.side === actor.side) {
          const heal = Math.max(1, Math.round(tar.maxHp * 0.10));
          const after = Math.min(tar.maxHp, tar.hp + heal);
          tar.hp = after;
          tar.aquariusDmgBonus = 0.15;
          tar.aquariusRounds = 2;
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 21050,
            id: 21050,
            effect_phase: phase,
            change_type: 200000,
            change_value: [heal],
            remove_round: 0,
          });
        }
      });
    } else if (cfg.nature === 3) {
      const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
        if (allies.length > 0) {
          const chosen = allies[Math.floor(rnd() * allies.length)];
          gainStat(chosen, 105, 1, { effects, srcId: 21050, atkId: actor.id, srcServantId: actor.id, phase });
        }
    }
  }

  // 93. 巨蟹座（21100 囚神的鳌爪）：攻击叠层，1层偷取能力，2层造成当前生命35%伤害
  if (actor.talent === 21100) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side !== actor.side) {
        tar.cancerClawStacks = (tar.cancerClawStacks || 0) + 1;
        if (tar.cancerClawStacks >= 2) {
          tar.cancerClawStacks = 0;
          const magAtkLv = (actor.statLevels && actor.statLevels[102]) || 0;
          const ratio = 0.35 + (magAtkLv * 0.05);
          const burst = Math.max(1, Math.round(tar.hp * ratio));
          tar.hp = Math.max(1, tar.hp - burst);
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 21100,
            id: 21100,
            effect_phase: phase,
            change_type: 200000,
            change_value: [-burst],
            remove_round: 0,
          });
        } else if (tar.cancerClawStacks === 1) {
          // 偷取1项能力
          const props = [101, 102, 103, 104, 105];
          const p = props[Math.floor(rnd() * props.length)];
          tar.statLevels = tar.statLevels || {};
          actor.statLevels = actor.statLevels || {};
          tar.statLevels[p] = Math.max(-6, (tar.statLevels[p] || 0) - 1);
          actor.statLevels[p] = Math.min(6, (actor.statLevels[p] || 0) + 1);
        }
      }
    });
  }

  // 94. 狮子座（21110 狮王之裘）：造成一次伤害后积累1层
  if (actor.talent === 21110 && cfg.power > 0) {
    actor.leoFurStacks = Math.min(5, (actor.leoFurStacks || 0) + 1);
  }

  // 101. 卯（22020 兔子的仙药）：使用一次辅助技能后己方所有誓灵随机获得一种增益
  if (actor.talent === 22020 && (Number(cfg.kind) === 3 || isFriendEff(cfg.effType))) {
    const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
    allies.forEach(a => {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(rnd() * props.length)];
      a.statLevels = a.statLevels || {};
      a.statLevels[p] = Math.min(6, (a.statLevels[p] || 0) + 1);
      const an = PROP_ATTR_NAMES[p];
      if (an) a[an] = a.statLevels[p];
    });
    effects.push({
      trigger_count: 0,
      atk_servant_id: actor.id,
      src_servant_id: actor.id,
      tar_servant_ids: allies.map(a => a.id),
      src_type: 1,
      src_id: 22020,
      id: 22020,
      effect_phase: phase,
      change_type: 100000,
      change_value: [],
      remove_round: 0,
    });
  }

  // 92. 双子座（21090 光影双生）：每命中一名敌人减伤叠层
  if (actor.talent === 21090 && cfg.power > 0) {
    actor.geminiMitStacks = (actor.geminiMitStacks || 0) + 1;
  }

  // 105. 未（22060 日斜）：造成伤害后使己方生命最低誓灵回复15%伤害量生命且较高攻击+1
  if (actor.talent === 22060 && cfg.power > 0) {
    const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
    if (allies.length > 0) {
      const lowest = allies.slice().sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
      const dealt = (results && Array.isArray(results)) ? results.reduce((s, r) => s + (r.hurt || 0), 0) : 0;
      const heal = Math.max(1, Math.round(dealt * 0.15));
      const after = Math.min(lowest.maxHp, lowest.hp + heal);
      lowest.hp = after;
        const prop = (lowest.attrs && lowest.attrs.phy_atk >= lowest.attrs.mag_atk) ? 101 : 102;
        gainStat(lowest, prop, 1, { effects, srcId: 22060, atkId: actor.id, srcServantId: actor.id, phase });
      effects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [lowest.id],
        src_type: 1,
        src_id: 22060,
        id: 22060,
        effect_phase: phase,
        change_type: 200000,
        change_value: [heal],
        remove_round: 0,
      });
    }
  }

  // =========================================================================
  // SR 阶段六（Phase 6）checkTalentsAfterSkill 终局触发
  // =========================================================================
  // 110. 伊塔库亚（21920 风行者之路）：每次使用风系技能后本回合己方受群体伤害减少30%
  if (actor.talent === 21920 && cfg.nature === 3) {
    (allUnits || []).forEach(a => {
      if (a && a.hp > 0 && a.side === actor.side) a.itaquaWindUsed = true;
    });
    // 叠加风行者印记
    actor.windWalkerMarks = (actor.windWalkerMarks || 0) + 1;
  }

  // 116. 持国天（22280 中道之琴）：声音类技能己方2回合内受伤降低15%，敌方最高攻-2、最低攻+1
  if (actor.talent === 22280 && isSoundSkill(cfg.id)) {
    (allUnits || []).forEach(a => {
      if (a && a.hp > 0 && a.side === actor.side) a.dhrtarastraMitRounds = 2;
    });
    const foes = (allUnits || []).filter(f => f && f.hp > 0 && f.side !== actor.side);
    if (foes.length > 0) {
      const sorted = foes.slice().sort((a, b) => (b.attrs.phy_atk + b.attrs.mag_atk) - (a.attrs.phy_atk + a.attrs.mag_atk));
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];
        if (highest) {
          const hp = (highest.attrs.phy_atk >= highest.attrs.mag_atk) ? 101 : 102;
          gainStat(highest, hp, -2, { effects, srcId: 22280, atkId: actor.id, srcServantId: actor.id, phase });
        }
        if (lowest && lowest !== highest) {
          const lp = (lowest.attrs.phy_atk >= lowest.attrs.mag_atk) ? 101 : 102;
          gainStat(lowest, lp, 1, { effects, srcId: 22280, atkId: actor.id, srcServantId: actor.id, phase });
      }
    }
  }

  // 122. 阿修罗（22720 阿修罗道）：使用辅助技能消耗50战意获得+2优先度
  if (actor.talent === 22720 && (Number(cfg.kind) === 3 || isFriendEff(cfg.effType)) && (actor.asuraWill || 0) >= 50) {
    actor.asuraWill -= 50;
    actor.asuraPriorityUp = 2;
  }

  // 125. 凯布利（22850 圣甲虫之秘）：己方下次攻击附带失血百分比75%的增伤与吸血
  if (actor.khepriNextBonus > 0) {
    // 消耗在下次攻击结算时（由伤害乘区处理）
  }

  // 83. 高尔（23160 弑君）：对总能力等级>=6的目标造成伤害后追加伤害并偷取3项正向能力1级
  if (actor.talent === 23160 && cfg.power > 0) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side !== actor.side && tar.statLevels) {
        let totalStats = 0;
        Object.values(tar.statLevels).forEach(lv => { totalStats += Math.abs(lv || 0); });
        if (totalStats >= 6) {
          const extraDmg = Math.max(1, Math.round(totalStats * 0.10 * tar.maxHp / 100));
          tar.hp = Math.max(1, tar.hp - extraDmg);
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 23160,
            id: 23160,
            effect_phase: phase,
            change_type: 200000,
            change_value: [-extraDmg],
            remove_round: 0,
          });
          // 偷取3项正向能力1级
          const posProps = Object.keys(tar.statLevels).filter(k => tar.statLevels[k] > 0).slice(0, 3);
          posProps.forEach(pk => {
            const p = Number(pk);
            tar.statLevels[p] = Math.max(-6, tar.statLevels[p] - 1);
            actor.statLevels = actor.statLevels || {};
            actor.statLevels[p] = Math.min(6, (actor.statLevels[p] || 0) + 1);
          });
        }
      }
    });
  }

  // 32. 阿斯莫德（21780 爱之恶堕者）：使用单体技能对目标造成伤害后，该目标下回合伤害降低20%
  if (actor.talent === 21780 && cfg.power > 0) {
    (targets || []).forEach(tar => {
      if (tar && tar.hp > 0 && tar.side !== actor.side) {
        tar.asmodeusDmgDownNextRound = true;
      }
    });
  }

  // 39. 拉克西丝（23080 命运延展）：自身成功使用技能后清除敌方全体随机一项能力等级
  if (actor.talent === 23080) {
    const foes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
    foes.forEach(foe => {
      if (foe.statLevels) {
        const nonZero = Object.keys(foe.statLevels).filter(k => foe.statLevels[k] !== 0);
        if (nonZero.length > 0) {
          const p = Number(nonZero[Math.floor(rnd() * nonZero.length)]);
          const oldLv = foe.statLevels[p] || 0;
          const newLv = 0;
          const delta = newLv - oldLv;
          foe.statLevels[p] = newLv;
          const an = PROP_ATTR_NAMES[p];
          if (an) foe[an] = newLv;
          if (delta !== 0) {
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id,
              src_servant_id: actor.id,
              tar_servant_ids: [foe.id],
              src_type: 1,
              src_id: 23080,
              id: 23080,
              effect_phase: phase,
              change_type: 100000,
              change_value: [encodeAttrVal(p, delta, newLv)],
              remove_round: 0,
            });
          }
        }
      }
    });
  }

  // 37. 莎莉叶（22550 光暗交织）：与光暗属性誓灵交互后叠层增伤（最高50%）
  if (actor.talent === 22550 && (cfg.nature === 5 || cfg.nature === 6)) {
    actor.sharayahStacks = Math.min(5, (actor.sharayahStacks || 0) + 1);
  }
  if ((targets || []).some(tar => tar && tar.talent === 22550 && (cfg.nature === 5 || cfg.nature === 6))) {
    (targets || []).forEach(tar => {
      if (tar && tar.talent === 22550) {
        tar.sharayahStacks = Math.min(5, (tar.sharayahStacks || 0) + 1);
      }
    });
  }

  // 1. 月读「月之蚀」（20730）：我方使用暗系技能后，敌方随机1名誓灵随机1项能力下降1级
  if (cfg.nature === 6) {
    const tsukuyomis = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.talent === 20730);
    tsukuyomis.forEach(tsu => {
      const foes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
      if (foes.length > 0) {
        const tar = foes[Math.floor(rnd() * foes.length)];
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const prop = props[Math.floor(rnd() * props.length)];
        tar.statLevels = tar.statLevels || {};
        const oldLv = tar.statLevels[prop] || 0;
        const newLv = Math.max(-6, Math.min(6, oldLv - 1));
        const realDelta = newLv - oldLv;
        tar.statLevels[prop] = newLv;
        const attrName = PROP_ATTR_NAMES[prop];
        if (attrName) tar[attrName] = newLv;

        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: tsu.id,
          tar_servant_ids: [tar.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 20730,
          id: 20730,
          effect_phase: phase,
          change_type: 100000, // FIGHT_EFF_CHANGE_TYPE_ATTR
          change_value: [encodeAttrVal(prop, realDelta)],
          remove_round: 0,
        });
      }
    });
  }

  // 2. 天照「日之耀」（20560）：场上誓灵使用光系技能后，己方随机1名誓灵随机1项能力提升1级
  if (cfg.nature === 5) {
    const amaterasus = (allUnits || []).filter(u => u && u.hp > 0 && u.talent === 20560);
    amaterasus.forEach(ama => {
      const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === ama.side);
      if (allies.length > 0) {
        const tar = allies[Math.floor(rnd() * allies.length)];
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const prop = props[Math.floor(rnd() * props.length)];
        tar.statLevels = tar.statLevels || {};
        const oldLv = tar.statLevels[prop] || 0;
        const newLv = Math.max(-6, Math.min(6, oldLv + 1));
        const realDelta = newLv - oldLv;
        tar.statLevels[prop] = newLv;
        const attrName = PROP_ATTR_NAMES[prop];
        if (attrName) tar[attrName] = newLv;

        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: ama.id,
          tar_servant_ids: [tar.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 20560,
          id: 20560,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, realDelta)],
          remove_round: 0,
        });
      }
    });
  }

  // 3. 洛基「邪神业火」（20010）：自身使用火属性技能对目标产生伤害时，目标物防、魔防下降1级
  if (actor.talent === 20010 && cfg.nature === 2 && Array.isArray(results)) {
    const damagedTargets = results.filter(r => r.hurt > 0);
    damagedTargets.forEach(r => {
      const tar = (allUnits || []).find(u => u && u.id === r.target && u.hp > 0);
      if (tar) {
        [103, 104].forEach(prop => {
          tar.statLevels = tar.statLevels || {};
          const oldLv = tar.statLevels[prop] || 0;
          const newLv = Math.max(-6, Math.min(6, oldLv - 1));
          const realDelta = newLv - oldLv;
          tar.statLevels[prop] = newLv;
          const attrName = PROP_ATTR_NAMES[prop];
          if (attrName) tar[attrName] = newLv;

          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1, // FIGHT_EFF_FEATURE
            src_id: 20010,
            id: 20010,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(prop, realDelta)],
            remove_round: 0,
          });
        });
      }
    });
  }

  // 4. 乐正绫「乐祈」（21320）：自身使用声音类技能造成伤害后，伤害的 20% 变成护盾值
  if (actor.talent === 21320 && isSoundSkill(cfg.id) && Array.isArray(results)) {
    const totalDmg = results.reduce((sum, r) => sum + (Number(r.hurt) || 0) + (Number(r.shield_hurt) || 0), 0);
    if (totalDmg > 0 && actor.hp > 0) {
      const shieldRatio = 0.20;
      const addShield = Math.max(1, Math.round(totalDmg * shieldRatio));
      const maxHp = Number(actor.maxHp || (actor.attrs && actor.attrs.hp) || actor.hp) || 1000;
      const curShield = Number(actor.shield) || 0;
      const newShield = Math.min(maxHp, curShield + addShield);
      const delta = newShield - curShield;
      if (delta > 0) {
        actor.shield = newShield;
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 21320,
          id: 21320, // 乐祈
          effect_phase: phase,
          change_type: 200001, // FIGHT_EFF_CHANGE_TYPE_SHIELD
          change_value: [delta],
          remove_round: 0,
        });
      }
    }
  }

  // 5. 乐正绫-蝶律「幻舞之蝶」（21350）：自身使用声音类技能造成伤害后，根据命中的敌人数量 N，随机 1 项能力提升 N 级
  if (actor.talent === 21350 && isSoundSkill(cfg.id) && Array.isArray(results)) {
    const hitFoes = results.filter(r => (Number(r.hurt) > 0 || Number(r.shield_hurt) > 0) && (allUnits || []).some(u => u && u.id === r.target && u.side !== actor.side));
    const hitCount = hitFoes.length;
    if (hitCount > 0 && actor.hp > 0) {
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const prop = props[Math.floor(rnd() * props.length)];
      actor.statLevels = actor.statLevels || {};
      const oldLv = actor.statLevels[prop] || 0;
      const newLv = Math.max(-6, Math.min(6, oldLv + hitCount));
      const realDelta = newLv - oldLv;
      actor.statLevels[prop] = newLv;
      const attrName = PROP_ATTR_NAMES[prop];
      if (attrName) actor[attrName] = newLv;
      if (realDelta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [actor.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 21350,
          id: 21350,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, realDelta, newLv)],
          remove_round: 0,
        });
      }
    }
  }

  // 6. 鸢一折纸「天使」（21670）：己方使用光系技能后，折纸获得 2 层天使之光（最多 10 层）
  if (cfg.nature === 5) {
    const origamis = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21670);
    origamis.forEach(ori => {
      const oldStacks = ori.angel_light_stacks || 0;
      const newStacks = Math.min(10, oldStacks + 2);
      ori.angel_light_stacks = newStacks;
      const delta = newStacks - oldStacks;
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: ori.id,
          tar_servant_ids: [ori.id],
          src_type: 1,
          src_id: 21670,
          id: 21670,
          effect_phase: phase,
          change_type: 300019,
          // 三百一十三纠错：原 change_value:[newStacks] 是裸层数——客户端按 %1e6 解码成
          // buffId=2..10 → getBuffVO printError「不存在的BUFFID」+ 回落麻痹 VO 挂假麻痹图标；
          // 必须过 encodeBuffVal（level*1e6 + buffId 21670）
          change_value: [encodeBuffVal(21670, newStacks)],
          remove_round: 0,
        });
      }
    });
  }

  // 7. 路西法「傲慢之罪」（22540）：对生命值低于 50% 的目标造成伤害后，目标随机 2 项能力等级下降 1 级
  if (actor.talent === 22540 && Array.isArray(results)) {
    results.forEach(r => {
      if (Number(r.hurt) > 0 || Number(r.shield_hurt) > 0) {
        const tar = (allUnits || []).find(u => u && u.id === r.target && u.hp > 0);
        if (tar && ((tar.hp / tar.maxHp) < 0.5 || actor.arroganceBoth)) {
          const props = [101, 102, 103, 104, 105, 111, 113, 115];
          const shuffled = props.slice().sort(() => rnd() - 0.5);
          const picked = shuffled.slice(0, 2);
          const changeVals = [];
          picked.forEach(p => {
            tar.statLevels = tar.statLevels || {};
            const oldLv = tar.statLevels[p] || 0;
            const newLv = Math.max(-6, Math.min(6, oldLv - 1));
            const realDelta = newLv - oldLv;
            tar.statLevels[p] = newLv;
            const attrName = PROP_ATTR_NAMES[p];
            if (attrName) tar[attrName] = newLv;
            if (realDelta !== 0) changeVals.push(encodeAttrVal(p, realDelta, newLv));
          });
          if (changeVals.length > 0) {
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id,
              src_servant_id: actor.id,
              tar_servant_ids: [tar.id],
              src_type: 1,
              src_id: 22540,
              id: 22540,
              effect_phase: phase,
              change_type: 100000,
              change_value: changeVals,
              remove_round: 0,
            });
          }
        }
      }
    });
  }

  // 8. 爱丽丝「红桃杀手」（22750）：攻击造成伤害后目标叠加 1 层红桃印记；达到 3 层时目标全能力下降 2 级且自身睡眠
  if (actor.talent === 22750 && Array.isArray(results)) {
    results.forEach(r => {
      if (Number(r.hurt) > 0 || Number(r.shield_hurt) > 0) {
        const tar = (allUnits || []).find(u => u && u.id === r.target && u.hp > 0);
        if (tar) {
          tar.hearts = (tar.hearts || 0) + 1;
          if (tar.hearts >= 3) {
            tar.hearts = 0;
            const allProps = [101, 102, 103, 104, 105, 111, 113, 115];
            const changeVals = [];
            allProps.forEach(p => {
              tar.statLevels = tar.statLevels || {};
              const oldLv = tar.statLevels[p] || 0;
              const newLv = Math.max(-6, Math.min(6, oldLv - 2));
              const realDelta = newLv - oldLv;
              tar.statLevels[p] = newLv;
              const attrName = PROP_ATTR_NAMES[p];
              if (attrName) tar[attrName] = newLv;
              if (realDelta !== 0) changeVals.push(encodeAttrVal(p, realDelta, newLv));
            });
            if (changeVals.length > 0) {
              effects.push({
                trigger_count: 0,
                atk_servant_id: actor.id,
                src_servant_id: actor.id,
                tar_servant_ids: [tar.id],
                src_type: 1,
                src_id: 22750,
                id: 22750,
                effect_phase: phase,
                change_type: 100000,
                change_value: changeVals,
                remove_round: 0,
              });
            }
            if (actor.hp > 0) {
              actor.buffs = actor.buffs || {};
              actor.buffs[BUFF_IDS.SLEEP] = { level: 1, duration: 3 };
              effects.push({
                trigger_count: 0,
                atk_servant_id: actor.id,
                src_servant_id: actor.id,
                tar_servant_ids: [actor.id],
                src_type: 1,
                src_id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].apply,
                id: BUFF_FEATURE_IDS[BUFF_IDS.SLEEP].apply,
                effect_phase: phase,
                change_type: 300019,
                change_value: [BUFF_IDS.SLEEP],
                remove_round: 3,
              });
            }
          }
        }
      }
    });
  }

  // 9. 阿波罗「神圣开悟」（23050）：使用技能后，将自身一半正向攻击等级分配至队友
  if (actor.talent === 23050 && actor.hp > 0) {
    const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.id !== actor.id);
    if (allies.length > 0) {
      actor.statLevels = actor.statLevels || {};
      [101, 102].forEach(prop => {
        const curLv = actor.statLevels[prop] || 0;
        if (curLv > 0) {
          const give = Math.floor(curLv / 2);
          if (give > 0) {
            actor.statLevels[prop] = curLv - give;
            const aName = PROP_ATTR_NAMES[prop];
            if (aName) actor[aName] = curLv - give;
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id,
              src_servant_id: actor.id,
              tar_servant_ids: [actor.id],
              src_type: 1,
              src_id: 23050,
              id: 23050,
              effect_phase: phase,
              change_type: 100000,
              change_value: [encodeAttrVal(prop, -give, curLv - give)],
              remove_round: 0,
            });
            allies.forEach(ally => {
              ally.statLevels = ally.statLevels || {};
              const oldAllyLv = ally.statLevels[prop] || 0;
              const newAllyLv = Math.max(-6, Math.min(6, oldAllyLv + give));
              const d = newAllyLv - oldAllyLv;
              ally.statLevels[prop] = newAllyLv;
              const allyName = PROP_ATTR_NAMES[prop];
              if (allyName) ally[allyName] = newAllyLv;
              if (d > 0) {
                effects.push({
                  trigger_count: 0,
                  atk_servant_id: actor.id,
                  src_servant_id: actor.id,
                  tar_servant_ids: [ally.id],
                  src_type: 1,
                  src_id: 23050,
                  id: 23050,
                  effect_phase: phase,
                  change_type: 100000,
                  change_value: [encodeAttrVal(prop, d, newAllyLv)],
                  remove_round: 0,
                });
              }
            });
          }
        }
      });
    }
  }

  // 10. 洛天依（21310 洛澜）：己方 Vsinger 使用声音类技能造成伤害后，随机 1 名敌方受到当前生命 5% * Vsinger数量的伤害
  if (isVsinger(actor.type) && isSoundSkill(cfg.id)) {
    const hasDmg = (results || []).some(r => (r.hurt > 0 || r.shield_hurt > 0));
    if (hasDmg) {
      const lty = (allUnits || []).find(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21310);
      if (lty) {
        const vsingerCount = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && isVsinger(u.type)).length;
        const aliveFoes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
        if (aliveFoes.length > 0 && vsingerCount > 0) {
          const tar = aliveFoes[Math.floor(rnd() * aliveFoes.length)];
          const ratio = vsingerCount * 0.05;
          const dmg = Math.max(1, Math.round(tar.hp * ratio));
          tar.hp = Math.max(0, tar.hp - dmg);
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id /* 修复：按 curEffData.atk_id 查桶 */,
            src_servant_id: lty.id,
            tar_servant_ids: [tar.id],
            src_type: 1, // FIGHT_EFF_FEATURE
            src_id: 21310,
            id: 21310,
            effect_phase: phase,
            change_type: 200000,
            change_value: [-dmg],
            remove_round: 0,
          });
        }
      }
    }
  }

  // 11. 时崎狂三（21650 梦魇）：己方暗属性技能造成伤害后，使目标获得1层【束缚之影】；3层扣除25%最大生命
  if (cfg.nature === 6) {
    const kurumi = (allUnits || []).find(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21650);
    if (kurumi) {
      (results || []).forEach(r => {
        if (r.hurt > 0 || r.shield_hurt > 0) {
          const tar = (allUnits || []).find(u => u && u.id === r.target && u.hp > 0);
          if (tar) {
            tar.shadow_bind = (tar.shadow_bind || 0) + 1;
            if (tar.shadow_bind >= 3) {
              tar.shadow_bind = 0;
              const maxHpDmg = Math.max(1, Math.round(tar.maxHp * 0.25));
              tar.hp = Math.max(0, tar.hp - maxHpDmg);
              effects.push({
                trigger_count: 0,
                atk_servant_id: actor.id /* 修复：按 curEffData.atk_id 查桶 */,
                src_servant_id: kurumi.id,
                tar_servant_ids: [tar.id],
                src_type: 1,
                src_id: 21650,
                id: 21650,
                effect_phase: phase,
                change_type: 200000,
                change_value: [-maxHpDmg],
                remove_round: 0,
              });
            } else {
              effects.push({
                trigger_count: 0,
                atk_servant_id: actor.id /* 修复：按 curEffData.atk_id 查桶 */,
                src_servant_id: kurumi.id,
                tar_servant_ids: [tar.id],
                src_type: 1,
                src_id: 21650,
                id: 21650,
                effect_phase: phase,
                change_type: 0,
                change_value: [tar.shadow_bind],
                remove_round: 0,
              });
            }
          }
        }
      });
    }
  }

  // 12. 洛天依-杏辞（21340 轻盈之杏）：每次受到声音伤害后，受到的声音伤害提高20%，该效果达到80%后重新计算
  const xingciUnit = (allUnits || []).find(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21340);
  if (xingciUnit && isSoundSkill(cfg.id)) {
    (results || []).forEach(r => {
      if (r.hurt > 0 || r.shield_hurt > 0) {
        const tar = (allUnits || []).find(u => u && u.id === r.target && u.hp > 0);
        if (tar) {
          tar.soundVulnRatio = (tar.soundVulnRatio || 0) + 0.20;
          if (tar.soundVulnRatio >= 0.80) {
            tar.soundVulnRatio = 0;
          }
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: xingciUnit.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 21340,
            id: 21340,
            effect_phase: phase,
            change_type: 0,
            change_value: [Math.round(tar.soundVulnRatio * 100)],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 13. 言和-兰序（21360 静姝之兰）：造成的单次声音伤害的60%会平分给己方所有誓灵用来回复生命
  if (actor.talent === 21360 && isSoundSkill(cfg.id)) {
    const totalSoundHurt = (results || []).reduce((sum, r) => sum + (r.hurt > 0 ? r.hurt : 0), 0);
    if (totalSoundHurt > 0) {
      const livingAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
      if (livingAllies.length > 0) {
        const splitHeal = Math.max(1, Math.round((totalSoundHurt * 0.60) / livingAllies.length));
        livingAllies.forEach(ally => {
          const healAmt = Math.min(ally.maxHp - ally.hp, splitHeal);
          if (healAmt > 0) {
            ally.hp += healAmt;
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id,
              src_servant_id: actor.id,
              tar_servant_ids: [ally.id],
              src_type: 1,
              src_id: 21360,
              id: 21360,
              effect_phase: phase,
              change_type: 200000,
              change_value: [healAmt],
              remove_round: 0,
            });
          }
        });
      }
    }
  }

  // 14. 四糸乃（21690 隐居者）：水属性单体技能造成伤害后，降低目标及周围敌方1级速度；敌方速度每下降3级提升自身1级魔攻
  if (actor.talent === 21690 && cfg.nature === 1) {
    const isSingleFoe = EFF_FOE_ONE.has(Number(cfg.effType)) || Number(cfg.effType) === 1007 || targets.length === 1;
    if (isSingleFoe) {
      const hitFoeResults = (results || []).filter(r => (r.hurt > 0 || r.shield_hurt > 0));
      hitFoeResults.forEach(r => {
        const mainTar = (allUnits || []).find(u => u && u.id === r.target && u.hp > 0);
        if (mainTar) {
          // 目标及周围敌方（曼哈顿距离 <= 1）
          const affected = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side &&
            (Math.abs(u.pos[0] - mainTar.pos[0]) + Math.abs(u.pos[1] - mainTar.pos[1]) <= 1));
          let totalSpeedDrops = 0;
          affected.forEach(tar => {
            tar.statLevels = tar.statLevels || {};
            const oldSpd = tar.statLevels[105] || 0;
            const newSpd = Math.max(-6, oldSpd - 1);
            if (newSpd < oldSpd) {
              tar.statLevels[105] = newSpd;
              tar.speed_lv = newSpd;
              totalSpeedDrops++;
              effects.push({
                trigger_count: 0,
                atk_servant_id: actor.id,
                src_servant_id: actor.id,
                tar_servant_ids: [tar.id],
                src_type: 1,
                src_id: 21690,
                id: 20005, // 速度下降
                effect_phase: phase,
                change_type: 100000,
                change_value: [encodeAttrVal(105, -1, newSpd)],
                remove_round: 0,
              });
            }
          });
          if (totalSpeedDrops > 0) {
            actor.yoshinoSpeedDrops = (actor.yoshinoSpeedDrops || 0) + totalSpeedDrops;
            if (actor.yoshinoSpeedDrops >= 3) {
              const matkGains = Math.floor(actor.yoshinoSpeedDrops / 3);
              actor.yoshinoSpeedDrops %= 3;
              const realDelta = gainStat(actor, 102, matkGains, { effects, srcId: actor.talent || 0, atkId: actor.id, srcServantId: actor.id, phase: 7 });
              if (realDelta > 0) {
                effects.push({
                  trigger_count: 0,
                  atk_servant_id: actor.id,
                  src_servant_id: actor.id,
                  tar_servant_ids: [actor.id],
                  src_type: 1,
                  src_id: 21690,
                  id: 21690,
                  effect_phase: phase,
                  change_type: 100000,
                  change_value: [encodeAttrVal(102, realDelta, (actor.statLevels && actor.statLevels[102]) || 0)],
                  remove_round: 0,
                });
              }
            }
          }
        }
      });
    }
  }

  // 15. 白雪公主（22740 七色之星）：释放技能后，己方所有与该技能同属性的誓灵获得10%最大生命护盾且随机能力+2
  if (actor.talent === 22740) {
    const matchedAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.nature === cfg.nature);
    matchedAllies.forEach(ally => {
      const shieldVal = Math.max(1, Math.round(ally.maxHp * 0.10));
      ally.shield = (Number(ally.shield) || 0) + shieldVal;
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(rnd() * props.length)];
      ally.statLevels = ally.statLevels || {};
      const oldLv = ally.statLevels[p] || 0;
      const newLv = Math.min(6, oldLv + 2);
      const delta = newLv - oldLv;
      ally.statLevels[p] = newLv;
      const an = PROP_ATTR_NAMES[p];
      if (an) ally[an] = newLv;
      effects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [ally.id],
        src_type: 1,
        src_id: 22740,
        id: 22740,
        effect_phase: phase,
        change_type: 200001, // SHIELD
        change_value: [shieldVal],
        remove_round: 0,
      });
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [ally.id],
          src_type: 1,
          src_id: 22740,
          id: PROP_FEATURE_IDS[p] || 20000,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(p, delta, newLv)],
          remove_round: 0,
        });
      }
    });
  }

  // 16. 维达（21500 万物复苏）：使用风属性技能后，己方风属性誓灵回复最大HP的7%且随机1项能力+1
  if (actor.talent === 21500 && cfg.nature === 3) {
    const windAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && natureOf(u.type) === 3);
    windAllies.forEach(ally => {
      const healAmt = Math.min(ally.maxHp - ally.hp, Math.max(1, Math.round(ally.maxHp * 0.07)));
      if (healAmt > 0) ally.hp += healAmt;
      const props = [101, 102, 103, 104, 105, 111, 113, 115];
      const p = props[Math.floor(rnd() * props.length)];
      ally.statLevels = ally.statLevels || {};
      const oldLv = ally.statLevels[p] || 0;
      const newLv = Math.min(6, oldLv + 1);
      const delta = newLv - oldLv;
      ally.statLevels[p] = newLv;
      const an = PROP_ATTR_NAMES[p];
      if (an) ally[an] = newLv;
      effects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [ally.id],
        src_type: 1,
        src_id: 21500,
        id: 21500,
        effect_phase: phase,
        change_type: 200000,
        change_value: [healAmt],
        remove_round: 0,
      });
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: actor.id,
          tar_servant_ids: [ally.id],
          src_type: 1,
          src_id: 21500,
          id: PROP_FEATURE_IDS[p] || 20000,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(p, delta, newLv)],
          remove_round: 0,
        });
      }
    });
  }

  // 17. 应龙（20820 大地的恩泽）：在场时，己方土系誓灵受到技能伤害后回复最大生命5%且命中、速度提升1级
  (results || []).forEach(res => {
    if (res.hurt > 0) {
      const hitUnit = (allUnits || []).find(u => u && u.id === res.target);
      if (hitUnit && hitUnit.hp > 0 && natureOf(hitUnit.type) === 4) {
        const yinglongAlly = (allUnits || []).find(u => u && u.hp > 0 && u.side === hitUnit.side && u.talent === 20820);
        if (yinglongAlly) {
          const healAmt = Math.min(hitUnit.maxHp - hitUnit.hp, Math.max(1, Math.round(hitUnit.maxHp * 0.05)));
          if (healAmt > 0) hitUnit.hp += healAmt;
          hitUnit.statLevels = hitUnit.statLevels || {};
          const chgVals = [];
          [113, 105].forEach(prop => {
            const oLv = hitUnit.statLevels[prop] || 0;
            const nLv = Math.min(6, oLv + 1);
            const d = nLv - oLv;
            hitUnit.statLevels[prop] = nLv;
            const aN = PROP_ATTR_NAMES[prop];
            if (aN) hitUnit[aN] = nLv;
            if (d > 0) chgVals.push(encodeAttrVal(prop, d, nLv));
          });
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: yinglongAlly.id,
            tar_servant_ids: [hitUnit.id],
            src_type: 1,
            src_id: 20820,
            id: 20820,
            effect_phase: phase,
            change_type: 200000,
            change_value: [healAmt],
            remove_round: 0,
          });
          if (chgVals.length) {
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id,
              src_servant_id: yinglongAlly.id,
              tar_servant_ids: [hitUnit.id],
              src_type: 1,
              src_id: 20820,
              id: 20820,
              effect_phase: phase,
              change_type: 100000,
              change_value: chgVals,
              remove_round: 0,
            });
          }
        }
      }
    }
  });

  // 18. 年-新春异兽（21290 烈焰激怒）：己方风属性誓灵受到火系伤害后较高攻击提升1级
  if (cfg.nature === 2) {
    (results || []).forEach(res => {
      if (res.hurt > 0) {
        const hitUnit = (allUnits || []).find(u => u && u.id === res.target);
        if (hitUnit && hitUnit.hp > 0 && natureOf(hitUnit.type) === 3) {
          const nianAlly = (allUnits || []).find(u => u && u.hp > 0 && u.side === hitUnit.side && u.talent === 21290);
          if (nianAlly) {
            hitUnit.statLevels = hitUnit.statLevels || {};
            const pAtk = hitUnit.statLevels[101] || 0;
            const mAtk = hitUnit.statLevels[102] || 0;
            const prop = (mAtk > pAtk) ? 102 : 101;
            const oLv = hitUnit.statLevels[prop] || 0;
            const nLv = Math.min(6, oLv + 1);
            const d = nLv - oLv;
            hitUnit.statLevels[prop] = nLv;
            const aN = PROP_ATTR_NAMES[prop];
            if (aN) hitUnit[aN] = nLv;
            if (d > 0) {
              effects.push({
                trigger_count: 0,
                atk_servant_id: actor.id,
                src_servant_id: nianAlly.id,
                tar_servant_ids: [hitUnit.id],
                src_type: 1,
                src_id: 21290,
                id: 21290,
                effect_phase: phase,
                change_type: 100000,
                change_value: [encodeAttrVal(prop, d, nLv)],
                remove_round: 0,
              });
            }
          }
        }
      }
    });
  }

  // 19. 后土（22670 土正）：每当土系誓灵受到伤害时，己方所有土系誓灵获得5%护盾
  (results || []).forEach(res => {
    if (res.hurt > 0) {
      const hitUnit = (allUnits || []).find(u => u && u.id === res.target);
      if (hitUnit && hitUnit.hp > 0 && natureOf(hitUnit.type) === 4) {
        const houtuAlly = (allUnits || []).find(u => u && u.hp > 0 && u.side === hitUnit.side && u.talent === 22670);
        if (houtuAlly) {
          const earthAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === hitUnit.side && natureOf(u.type) === 4);
          earthAllies.forEach(ea => {
            const sVal = Math.max(1, Math.round(ea.maxHp * 0.05));
            ea.shield = (Number(ea.shield) || 0) + sVal;
            effects.push({
              trigger_count: 0,
              atk_servant_id: actor.id,
              src_servant_id: houtuAlly.id,
              tar_servant_ids: [ea.id],
              src_type: 1,
              src_id: 22670,
              id: 22670,
              effect_phase: phase,
              change_type: 200001,
              change_value: [sVal],
              remove_round: 0,
            });
          });
        }
      }
    }
  });

  // 20. 须佐（21140 海之怒）：己方水属性誓灵使用攻击技能后，随机一项攻击能力提升1级
  if (natureOf(actor.type) === 1 && (cfg.power > 0 || (results || []).some(r => r.hurt > 0))) {
    const susanooAlly = (allUnits || []).find(u => u && u.hp > 0 && u.side === actor.side && u.talent === 21140);
    if (susanooAlly) {
      actor.statLevels = actor.statLevels || {};
      const prop = rnd() < 0.5 ? 101 : 102;
      const oLv = actor.statLevels[prop] || 0;
      const nLv = Math.min(6, oLv + 1);
      const d = nLv - oLv;
      actor.statLevels[prop] = nLv;
      const aN = PROP_ATTR_NAMES[prop];
      if (aN) actor[aN] = nLv;
      if (d > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: actor.id,
          src_servant_id: susanooAlly.id,
          tar_servant_ids: [actor.id],
          src_type: 1,
          src_id: 21140,
          id: 21140,
          effect_phase: phase,
          change_type: 100000,
          change_value: [encodeAttrVal(prop, d, nLv)],
          remove_round: 0,
        });
      }
    }
  }

  // 21. 加百列（21710 神之左）：天赋持有者使用辅助技能时，目标较高攻击上升一级
  if (actor.talent === 21710 && (cfg.power <= 0 || cfg.type === 3 || isFriendEff(cfg.effType))) {
    targets.forEach(tar => {
      if (tar && tar.hp > 0 && tar.side === actor.side) {
        const pAtk = (tar.attrs && tar.attrs.phy_atk) || tar.phy_atk || 0;
        const mAtk = (tar.attrs && tar.attrs.mag_atk) || tar.mag_atk || 0;
        const prop = (mAtk > pAtk) ? 102 : 101;
        const oLv = tar.statLevels[prop] || 0;
        const nLv = Math.min(6, oLv + 1);
        const d = nLv - oLv;
        tar.statLevels[prop] = nLv;
        const aN = PROP_ATTR_NAMES[prop];
        if (aN) tar[aN] = nLv;
        if (d > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: actor.id,
            tar_servant_ids: [tar.id],
            src_type: 1,
            src_id: 21710,
            id: 21710,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(prop, d, nLv)],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 22. 拉斐尔（21720 神之药）：使用辅助技能后，己方全体回复10%HP
  if (actor.talent === 21720 && (cfg.power <= 0 || cfg.type === 3 || isFriendEff(cfg.effType))) {
    const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
    allies.forEach(ally => {
      const healAmt = Math.min(ally.maxHp - ally.hp, Math.max(1, Math.round(ally.maxHp * 0.10)));
      if (healAmt > 0) ally.hp += healAmt;
      effects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [ally.id],
        src_type: 1,
        src_id: 21720,
        id: 21720,
        effect_phase: phase,
        change_type: 200000,
        change_value: [healAmt],
        remove_round: 0,
      });
    });
  }

  // 23. 赫斯提亚（20830 灶火的供奉）：誓灵每使用1次火属性技能，赫斯提亚随机1项能力提升1级
  if (cfg.nature === 2) {
    (allUnits || []).forEach(hestia => {
      if (hestia && hestia.hp > 0 && hestia.talent === 20830) {
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const p = props[Math.floor(rnd() * props.length)];
        hestia.statLevels = hestia.statLevels || {};
        const oLv = hestia.statLevels[p] || 0;
        const nLv = Math.min(6, oLv + 1);
        const d = nLv - oLv;
        hestia.statLevels[p] = nLv;
        const aN = PROP_ATTR_NAMES[p];
        if (aN) hestia[aN] = nLv;
        if (d > 0) {
          effects.push({
            trigger_count: 0,
            atk_servant_id: actor.id,
            src_servant_id: hestia.id,
            tar_servant_ids: [hestia.id],
            src_type: 1,
            src_id: 20830,
            id: 20830,
            effect_phase: phase,
            change_type: 100000,
            change_value: [encodeAttrVal(p, d, nLv)],
            remove_round: 0,
          });
        }
      }
    });
  }

  // 24. 盖布（21170 自然调和 / 无垠大地）：使用技能后，己方生命最高和最低誓灵平均血量且下次伤害+50%
  if (actor.talent === 21170) {
    const livingAllies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
    if (livingAllies.length >= 2) {
      livingAllies.sort((a, b) => a.hp - b.hp);
      const lowest = livingAllies[0];
      const highest = livingAllies[livingAllies.length - 1];
      const avgHp = Math.floor((lowest.hp + highest.hp) / 2);
      lowest.hp = Math.min(lowest.maxHp, avgHp);
      highest.hp = Math.min(highest.maxHp, avgHp);
      lowest.currDmgBonus = (lowest.currDmgBonus || 0) + 0.50;
      highest.currDmgBonus = (highest.currDmgBonus || 0) + 0.50;
      effects.push({
        trigger_count: 0,
        atk_servant_id: actor.id,
        src_servant_id: actor.id,
        tar_servant_ids: [lowest.id, highest.id],
        src_type: 1,
        src_id: 21170,
        id: 21170,
        effect_phase: phase,
        change_type: 200000,
        change_value: [lowest.hp, highest.hp],
        remove_round: 0,
      });
    }
  }

  // Phase 6 行动后天赋判定：
  // 1. 应龙-乾元（22930 真龙）：使用水(1)或土(4)技能叠真龙之力
  if (cfg.nature === 1 || cfg.nature === 4) {
    (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22930).forEach(yl => {
      yl.trueDragonLayers = Math.min(15, (yl.trueDragonLayers || 0) + 1);
    });
  }

  // 2. 亚瑟王（23000 雾夜启明）：己方光属性誓灵使用技能后，较高攻击与随机防御+1
  const hasArthur = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 23000);
  if (hasArthur && natureOf(actor.type) === 5) {
    const atkP = ((actor.attrs && actor.attrs.phy_atk) >= (actor.attrs && actor.attrs.mag_atk)) ? 101 : 102;
    const defP = rnd() < 0.5 ? 103 : 104;
    [atkP, defP].forEach(p => {
      gainStat(actor, p, 1, { effects, srcId: 23000, atkId: actor.id, srcServantId: actor.id, phase });
    });
  }

  // 3. 宇治松千夜（22890 腹黑气场）：己方使用技能敌方全体双防-1级
  const hasChiya = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22890);
  if (hasChiya) {
    const foes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
    foes.forEach(foe => {
      [103, 104].forEach(p => {
        gainStat(foe, p, -1, { effects, srcId: 22890, atkId: actor.id, srcServantId: actor.id, phase });
      });
    });
  }

  // 4. 冰糖燕窝（23100 正气强身）：成功使用技能为全队施加10%护盾
  // 2026-10-20：护盾原先只改 ally.shield，客户端没有任何反馈（技能结算的 final_shield
  // 只覆盖本次技能的目标，没被选中的队友永远是旧值）。这里逐人补一条 SHIELD 演出 effect：
  // 数值由 change_type=200001 携带，客户端 checkChange 里执行 shield + change_value。
  if (actor.talent === 23100) {
    const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
    allies.forEach(ally => {
      const maxH = ally.maxHp || (ally.attrs && ally.attrs.hp) || ally.hp;
      let shieldAmt = Math.max(1, Math.round(maxH * 0.10));
      const hasAnukis = (allUnits || []).some(u => u && u.hp > 0 && u.side === ally.side && u.talent === 22840);
      if (hasAnukis) shieldAmt = Math.floor(shieldAmt * 1.50);
      ally.shield = (ally.shield || 0) + shieldAmt;
      effects.push(featureFxEffect(actor, 23100, FX_23100, 200001, [shieldAmt], [ally.id], phase));
    });
  }

  // 5. 阿努凯特（22840 尼罗河母）：己方使用攻击技能消耗50%护盾对敌全员造成等额伤害
  // 2026-10-27：盾扣与敌方掉血原先零通道——敌方掉血属"打空气"（可能静默击杀，
  // 客户端下回合还在打一个已死单位），补 200001 负值 + 200000 负值
  if (cfg.power > 0) {
    const hasAnukis = (allUnits || []).some(u => u && u.hp > 0 && u.side === actor.side && u.talent === 22840);
    if (hasAnukis && actor.shield > 0) {
      const sacrifice = Math.floor(actor.shield * 0.50);
      if (sacrifice > 0) {
        actor.shield -= sacrifice;
        effects.push(featureFxEffect(actor, 22840, 22840, 200001, [-sacrifice], [actor.id], phase));
        const foes = (allUnits || []).filter(u => u && u.hp > 0 && u.side !== actor.side);
        foes.forEach(f => {
          const before = f.hp;
          f.hp = Math.max(0, f.hp - sacrifice);
          effects.push(featureFxEffect(actor, 22840, 22840, 200000, [f.hp - before], [f.id], phase));
        });
      }
    }
  }

  // 6. 河伯（22910 神赐之水）：造成伤害后伤者回血10%，无伤者随机升2项能力1级（联动桓雄创生）
  if (actor.talent === 22910 && Array.isArray(results)) {
    const totalHurt = results.reduce((s, r) => s + Math.max(0, (r.hurt || 0) + (r.shield_hurt || 0)), 0);
    if (totalHurt > 0) {
      const healAmt = Math.max(1, Math.floor(totalHurt * 0.10));
      const allies = (allUnits || []).filter(u => u && u.hp > 0 && u.side === actor.side);
      allies.forEach(ally => {
        const maxH = ally.maxHp || (ally.attrs && ally.attrs.hp) || ally.hp;
        if (ally.hp < maxH) {
          const before = ally.hp;
          ally.hp = Math.min(maxH, ally.hp + healAmt);
          // 2026-10-27：回血补 30531 甘露通道（狼人 20870 同款），否则全队回血不可见
          effects.push({
            trigger_count: 0, atk_servant_id: actor.id, src_servant_id: actor.id, tar_servant_ids: [ally.id],
            src_type: 1, src_id: 30531, id: 30531, effect_phase: phase,
            change_type: 200000, change_value: [Math.round(ally.hp) - Math.round(before)], remove_round: 0,
          });
          // 桓雄（22920 创生）：恢复生命触发创生增益
          const hasHwanung = (allUnits || []).some(u => u && u.hp > 0 && u.side === ally.side && u.talent === 22920);
          if (hasHwanung) {
            ally.hwanungBuffDmg = 0.50;
            ally.hwanungBuffMit = 0.25;
          }
        } else {
          const props = [101, 102, 103, 104, 105, 111, 113, 115];
          for (let i = 0; i < 2; i++) {
            const p = props[Math.floor(rnd() * props.length)];
            gainStat(ally, p, 1, { effects, srcId: 22920, atkId: actor.id, srcServantId: ally.id, phase });
          }
        }
      });
    }
  }

  // 出口统一展开（客户端按目标下标消费 change_value，见 splitEffectByTarget 注释）
  return flattenEffects(effects);
}

// 回合开始专属天赋触发器（如朱雀「泣朱」）
function settleRoundStartTalents(units, round, actIndex, battleState) {
  if (typeof actIndex === 'object' && actIndex !== null && battleState === undefined) {
    battleState = actIndex;
    actIndex = 0;
  }
  actIndex = Number(actIndex) || 0;
  applyRelicSharing(units);
  checkEntranceWeather(units, battleState, round);
  // 进场天赋要能把「能力等级变化」推给客户端，所以改成返回事件数组并入总出口
  // （原来 checkEntranceTalents 只改内存、什么都不返回，客户端永远看不到这批加成）。
  const effects = [];
  const entranceEffects = checkEntranceTalents(units, battleState, round) || [];
  if (entranceEffects.length) effects.push(...entranceEffects);
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 联动圣器专属·回合开始护盾（2026-10-25）：
    // 狐笋（白上吹雪专属）：每回合开始为自己增加 4% 最大生命的护盾；
    // 送给妹妹的面包（心爱专属）：每回合恢复 5% 护盾（上限=开场护盾量 30% 最大生命）。
    {
      const excS = u.relicMisc && u.relicMisc.excl;
      // 2026-10-27：回合开始护盾补 200001（静默 60120），否则每回合的盾增量不可见
      if (excS && excS.fubukiRoundShield) {
        const fbBefore = Math.round(Number(u.shield) || 0);
        u.shield = (u.shield || 0) + Math.max(1, Math.round((u.maxHp || (u.attrs && u.attrs.hp) || 1) * excS.fubukiRoundShield));
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
          src_type: 3, src_id: 0, id: 60120, effect_phase: 1,
          change_type: 200001, change_value: [Math.round(u.shield) - fbBefore], remove_round: 0,
        });
      }
      if (excS && excS.kaedeShieldRegen) {
        const ksMax = Math.round((u.maxHp || (u.attrs && u.attrs.hp) || 1) * 0.30);
        const ksBefore = Math.round(Number(u.shield) || 0);
        u.shield = Math.min(ksMax, (u.shield || 0) + Math.max(1, Math.round((u.maxHp || (u.attrs && u.attrs.hp) || 1) * excS.kaedeShieldRegen)));
        const ksGain = Math.round(u.shield) - ksBefore;
        if (ksGain > 0) {
          effects.push({
            trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [u.id],
            src_type: 3, src_id: 0, id: 60120, effect_phase: 1,
            change_type: 200001, change_value: [ksGain], remove_round: 0,
          });
        }
      }
    }

    // 大吉祥天（22270 宝莲）：回合开始时，赋予己方当前生命百分比最低的誓灵【宝莲庇佑】
    if (u.talent === 22270) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      allies.forEach(a => { a.lotusBlessed = false; });
      if (allies.length > 0) {
        const lowestAlly = allies.slice().sort((a, b) => {
          const aRatio = a.hp / (a.maxHp || (a.attrs && a.attrs.hp) || a.hp || 1);
          const bRatio = b.hp / (b.maxHp || (b.attrs && b.attrs.hp) || b.hp || 1);
          return aRatio - bRatio;
        })[0];
        if (lowestAlly) {
          lowestAlly.lotusBlessed = true;
          effects.push({
            trigger_count: 0,
            atk_servant_id: u.id,
            src_servant_id: u.id,
            tar_servant_ids: [lowestAlly.id],
            src_type: 1, // FIGHT_EFF_FEATURE
            src_id: 22270,
            id: 22270,
            effect_phase: 1, // TRIGGER_TIME_ROUND_START
            change_type: 0,
            change_value: [],
            remove_round: 0,
          });
        }
      }
    }

    // 猫又（21480 魔力盗取·回合开始段）：获得随机1名敌方1级魔攻，并记下目标供回合末判定归还
    if (u.talent === 21480) {
      const foesAlive = (units || []).filter(x => x && x.hp > 0 && x.side !== u.side);
      if (foesAlive.length > 0) {
        const victim = foesAlive[Math.floor(Math.random() * foesAlive.length)];
        u.manaStealTargetId = victim.id;
        gainStat(u, 102, 1, { effects, srcId: 21480, atkId: u.id, srcServantId: u.id, phase: 1 });
      }
    }

    // 朱雀（23280 泣朱）：每回合开始对自己造成最大生命 30% 伤害，自身下次行动伤害提高 30%
    // 因该效果导致生命为 0 则回复满血，下次伤害提高变成 60%，受到的技能伤害永久提高 60%
    if (u.talent === 23280) {
      const maxHp = Number(u.maxHp || (u.attrs && u.attrs.hp) || u.hp) || 1000;
      const selfDmg = Math.max(1, Math.ceil(maxHp * 0.30));
      if (u.hp - selfDmg <= 0) {
        // 致死涅槃：回复满血
        u.hp = maxHp;
        u.zhuqueSelfBoost = 0.60;
        u.zhuqueVuln = (u.zhuqueVuln || 0) + 0.60;
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 23280,
          id: 23280,
          effect_phase: 1, // TRIGGER_TIME_ROUND_START
          change_type: 200000, // HP change
          change_value: [maxHp],
          remove_round: 0,
        });
      } else {
        u.hp -= selfDmg;
        const hasBaihu = (units || []).some(b => b && b.hp > 0 && b.side === u.side && b.talent === 23300);
        u.zhuqueSelfBoost = hasBaihu ? 0.60 : 0.30;
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1,
          src_id: 23280,
          id: 23280,
          effect_phase: 1,
          change_type: 200000,
          change_value: [-selfDmg],
          remove_round: 0,
        });
      }
    }

    // 范格斯（23190 鲑鱼捕手）：回合开始时夺取1级魔攻与随机一项能力（若自身魔攻为负则敌方全体）
    if (u.talent === 23190) {
      const mAtkLv = (u.statLevels && u.statLevels[102]) || 0;
      const foes = (units || []).filter(x => x && x.hp > 0 && x.side !== u.side);
      if (foes.length > 0) {
        const targets = (mAtkLv < 0) ? foes : [foes[Math.floor(Math.random() * foes.length)]];
        const props = [101, 103, 104, 105, 111, 113, 115];
        targets.forEach(foe => {
          gainStat(foe, 102, -1, { effects, srcId: 23190, atkId: u.id, srcServantId: u.id, phase: 1 });
          gainStat(u, 102, 1, { effects, srcId: 23190, atkId: u.id, srcServantId: u.id, phase: 1 });

          const randP = props[Math.floor(Math.random() * props.length)];
          gainStat(foe, randP, -1, { effects, srcId: 23190, atkId: u.id, srcServantId: u.id, phase: 1 });
          gainStat(u, randP, 1, { effects, srcId: 23190, atkId: u.id, srcServantId: u.id, phase: 1 });
        });
      }
    }

    // 桐间纱路（22900 打工的贵族）：回合开始物/魔攻等级最低者伤害提升50%（全队最低则全队提升；点兔角色提升65%）
    if (u.talent === 22900) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      if (allies.length > 0) {
        let minLv = 999;
        allies.forEach(a => {
          const pLv = (a.statLevels && a.statLevels[101]) || 0;
          const mLv = (a.statLevels && a.statLevels[102]) || 0;
          const lower = Math.min(pLv, mLv);
          if (lower < minLv) minLv = lower;
        });
        const lowestAllies = allies.filter(a => {
          const pLv = (a.statLevels && a.statLevels[101]) || 0;
          const mLv = (a.statLevels && a.statLevels[102]) || 0;
          return Math.min(pLv, mLv) === minLv;
        });
        const targetList = (lowestAllies.length === allies.length) ? allies : lowestAllies;
        targetList.forEach(tar => {
          tar.syaroDmgBonus = isGochuumon(tar.type) ? 0.65 : 0.50;
        });
      }
    }

    // 常羲（23310 夜幕）：回合开始非夜幕天气，本回合敌方首个辅助技能转化为释放夜幕召来
    if (u.talent === 23310) {
      const curW = battleState && battleState.weather && battleState.weather.start_weather;
      if (curW !== WEATHER_IDS.NIGHT) {
        u.changxiNightIntercept = true;
      }
    }

    // 克塔亚特（22790 接触融合）：每回合重置单体吸引标记
    if (u.talent === 22790) {
      u.cthyllaAttract = true;
    }

    // 元素版警觉射击（10331）"目标不会被改变"的技能级豁免：动作结束即清，回合开始兜底再清一次。
    // 批次H1 神明启示（10244）：其目标锁是「下次攻击前一直有效」的 buff，须豁免本清理
    // （settleSkill 顶部在下次攻击技施放时消费并解除）。
    if (!u.nextAttackForceCrit) u.skillTargetLocked = false;

    // 玉子烧（23120 软绵回忆）：每回合冷却倒计时
    if (u.talent === 23120 && u.tamagoyakiCooldown > 0) {
      u.tamagoyakiCooldown--;
    }

        // 哈斯塔（22440 黄衣之王）：每回合开始除自身之外的随机一名无黄印的誓灵获得黄印标记
    if (u.talent === 22440) {
      const candidates = (units || []).filter(x => x && x.hp > 0 && x.id !== u.id && !x.yellowSign);
      if (candidates.length > 0) {
        const rnd = Math.random;
        const tar = candidates[Math.floor(rnd() * candidates.length)];
        tar.yellowSign = true;
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [tar.id],
          src_type: 1, // FIGHT_EFF_FEATURE
          src_id: 22440,
          id: 22440,
          effect_phase: 1, // TRIGGER_TIME_ROUND_START
          change_type: 0,
          change_value: [],
          remove_round: 0,
        });
      }
    }
  });
  // =========================================================================
  // SR 阶段六（Phase 6）回合初终局机制
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 130. 克洛托（23070 命运创生）：回合初全场角色随机2项能力等级+1
    // 原来只 push 一条 `change_value: []` 的空事件 —— 客户端拿到空值什么都不画，
    // 等于全场 2×N 次等级变化全部静默。这里按「每单位每属性一条」补全。
    if (u.talent === 23070) {
      const fateChanges = [];
      (units || []).forEach(x => {
        if (!x || x.hp <= 0) return;
        const props = [101, 102, 103, 104, 105, 111, 113, 115];
        const shuffled = props.slice().sort(() => Math.random() - 0.5).slice(0, 2);
        x.statLevels = x.statLevels || {};
        shuffled.forEach(p => {
          const oldLv = Number(x.statLevels[p]) || 0;
          const newLv = Math.min(6, oldLv + 1);
          const d = newLv - oldLv;
          x.statLevels[p] = newLv;
          const an = PROP_ATTR_NAMES[p];
          if (an) x[an] = newLv;
          if (d !== 0) fateChanges.push({ id: x.id, prop: p, delta: d });
        });
      });
      fateChanges.forEach(c => effects.push({
        trigger_count: 0,
        atk_servant_id: u.id,
        src_servant_id: u.id,
        tar_servant_ids: [c.id],
        src_type: 1,
        src_id: 23070,
        id: PROP_FEATURE_IDS[c.prop] || 20001,
        effect_phase: 1,
        change_type: 100000,
        change_value: [encodeAttrVal(c.prop, c.delta)],
        remove_round: 0,
      }));
    }

    // 127. 玉兔（22950 长生不老药）：在场时给予己方全体和登场队友一粒长生药
    // （三百一十三·续：CfgBuff[22950]「长生不老药」icon=TalentSkillIcom18——全表仅有的两个带图标
    //   天赋 buff 之一，药粒此前纯内部标记零下发；首次授予推 300019，消耗（复活）在 5763 段推 300020）
    if (u.talent === 22950) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      allies.forEach(a => {
        if (a.jadeRabbitElixir) return;
        a.jadeRabbitElixir = true;
        effects.push({
          trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [a.id],
          src_type: 1, src_id: 22950, id: 22950, effect_phase: 1,
          change_type: 300019, change_value: [encodeBuffVal(22950, 1)], remove_round: 0,
        });
      });
    }
  });

  // 128. 凡赛堤（22990 审判）：法典持续回合递减
  // （三百一十三：原块在上方逐单位 forEach **内部**——每个存活单位迭代都会把所有持有者递减一次，
  //   N 人存活 = 每回合递减 N 次，「持续2回合」实战只撑 1 回合；提升到函数体层级每回合只跑一次。
  //   客户端不自治过期——归零转冷却时必须显式推 300020 摘掉图标；id 用 60120（showName=0）
  //   静默摘除，不弹「审判」横幅；12395 禁锢同模式）
  (units || []).forEach(x => {
    if (x && x.forsetiCodexRounds > 0) {
      x.forsetiCodexRounds--;
      if (x.forsetiCodexRounds <= 0) {
        x.forsetiCodexActive = false;
        x.forsetiCodexCooldown = 2;
        effects.push({
          trigger_count: 0, atk_servant_id: x.id, src_servant_id: x.id, tar_servant_ids: [x.id],
          src_type: 1, src_id: 60120, id: 60120, effect_phase: 1,
          change_type: 300020, change_value: [22990], remove_round: 0,
        });
      }
    } else if (x && x.forsetiCodexCooldown > 0) {
      x.forsetiCodexCooldown--;
    }
  });

  // =========================================================================
  // SR 阶段五（Phase 5）回合初阵营生态触发
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 84. 处女座（21000 阿赖耶识）：回合初将我方誓灵生命值平均分配
    // 2026-10-27：护盾分支原先只改 a.shield + 一条 change_type=0 空 effect —— 客户端护盾条
    // 只有 200001 effect / 被击 final_shield 两条同步通道，授予瞬间零反馈（用户报"看不见护盾"）。
    // 照 23100 冰糖燕窝同款修法：逐人推 200001 + 官方展示条目 21002（act 20505 = P_jdfy 护盾动画）。
    if (u.talent === 21000) {
      const allies = (units || []).filter(a => a && a.hp > 0 && a.side === u.side);
      if (allies.length > 0) {
        const totalHp = allies.reduce((s, a) => s + a.hp, 0);
        const avg = Math.floor(totalHp / allies.length);
        allies.forEach(a => {
          const before = a.hp;
          a.hp = Math.min(a.maxHp, avg);
          if (a.hp > before) {
            // 血量上升：随机1项能力+2级（gainStat 自带 100000 演出；phase 对齐回合初同族口径）
            const props = [101, 102, 103, 104, 105, 111, 113, 115];
            const p = props[Math.floor(Math.random() * props.length)];
            gainStat(a, p, 2, { effects, srcId: 21000, atkId: u.id, srcServantId: u.id, phase: 1 });
          } else {
            // 血量下降或不变：获得10%护盾（src_id=21000 横幅取名、id=21002 官方演出条目）
            const shieldVal = Math.max(1, Math.round(a.maxHp * 0.10));
            a.shield = (Number(a.shield) || 0) + shieldVal;
            effects.push(featureFxEffect(u, 21000, 21002, 200001, [shieldVal], [a.id], 1));
          }
        });
      }
    }

    // 97. 小舟酱（21420 前线情报）：回合初随机获得 10%/35%/80%/150% 增伤
    if (u.talent === 21420) {
      const pool = [0.10, 0.35, 0.80, 1.50];
      u.xiaozhouDmgBonus = pool[Math.floor(Math.random() * pool.length)];
    }

    // 92. 双子座（21090 光影双生）：被攻击一次后效果清零（回合初不重置，仅在受击时清零）
  });

  // =========================================================================
  // SR 阶段三（Phase 3）回合初天气与周期触发
  // =========================================================================
  (units || []).forEach(u => {
    if (!u || u.hp <= 0) return;

    // 104. 亥（22100 滂沱）：记录回合初血量供回合末计算护盾
    if (u.talent === 22100) {
      u.haiRoundStartHp = u.hp;
    }
    // 99. 子（21990 通灵）：统计本战斗被击败誓灵数（上限5）
    if (u.talent === 21990) {
      const defeated = (units || []).filter(x => x && x.hp <= 0).length;
      u.ziDefeatedCount = Math.min(5, defeated);
    }

    // 73. 泣泽女神（22480 长寿之神女）：在场每多一回合，己方减伤递增5%（上限30%）
    if (u.talent === 22480) {
      u.nakizawaRounds = (u.nakizawaRounds || 0) + 1;
    }

    // 69. 兀尔德（20840 命运·过去）：结转上回合受击次数供本回合增伤
    u.verdandiPrevHits = (u.urdHitsLastRound || 0);
    u.urdHitsLastRound = 0;

    // 54. 密米尔（21440 智慧流转）：每回合开始时提升1级魔攻
    if (u.talent === 21440) {
      const delta = gainStat(u, 102, 1, { effects, srcId: 21440, atkId: u.id, srcServantId: u.id, phase: 1 });
      if (delta > 0) {
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [u.id],
          src_type: 1,
          src_id: 21440,
          id: 21440,
          effect_phase: 1,
          change_type: 100000,
          change_value: [encodeAttrVal(102, delta, (u.statLevels && u.statLevels[102]) || 0)],
          remove_round: 0,
        });
      }
    }

    // 55. 巴吉里斯克（21460 剧毒暴君）：回合开始时使场上一名随机誓灵中毒
    if (u.talent === 21460) {
      const alive = (units || []).filter(x => x && x.hp > 0);
      if (alive.length > 0) {
        const tar = alive[Math.floor(Math.random() * alive.length)];
        tar.buffs = tar.buffs || {};
        tar.buffs[BUFF_IDS.POISON] = { level: 1, duration: 3 };
        tar.poisonedByBasilisk = true;
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [tar.id],
          src_type: 1,
          src_id: 21460,
          id: 21460,
          effect_phase: 1,
          change_type: 300019,
          change_value: [encodeBuffVal(BUFF_IDS.POISON, 1)],
          remove_round: 3,
        });
      }
    }

    // 46. 厄洛斯（20660 姻缘的箭矢）：回合开始时使双方随机1名誓灵缔结契约一回合
    if (u.talent === 20660) {
      const allies = (units || []).filter(x => x && x.hp > 0 && x.side === u.side);
      const foes = (units || []).filter(x => x && x.hp > 0 && x.side !== u.side);
      if (allies.length > 0 && foes.length > 0) {
        const ally = allies[Math.floor(Math.random() * allies.length)];
        const foe = foes[Math.floor(Math.random() * foes.length)];
        ally.erosContractWith = foe.id;
        foe.erosContractWith = ally.id;
        ally.erosContractRounds = 1;
        foe.erosContractRounds = 1;
        effects.push({
          trigger_count: 0,
          atk_servant_id: u.id,
          src_servant_id: u.id,
          tar_servant_ids: [ally.id, foe.id],
          src_type: 1,
          src_id: 20660,
          id: 20660,
          effect_phase: 1,
          change_type: 0,
          change_value: [],
          remove_round: 1,
        });
      }
    }

    // 59. 厄庇墨透斯（22360 后见后知者）：出场后的下回合开始，每回合提升40%伤害（上限200%）
    if (u.talent === 22360) {
      u.epimetheusRounds = (u.epimetheusRounds || 0) + 1;
      if (u.epimetheusRounds >= 2) {
        u.epimetheusDmgBonus = Math.min(2.00, (u.epimetheusDmgBonus || 0) + 0.40);
      }
    }
  });

  // 出口统一展开（客户端按目标下标消费 change_value，见 splitEffectByTarget 注释）
  return flattenEffects(effects);
}

// 战斗开始（开局第一时间）结算：圣器共享 + 天气 + 进场天赋（三百一十三·续，2026-11-06）。
// 官方通道：round_start=1 首包 effect_list 的 phase=1 演出由客户端 startRound→dealFeatureData +
// onBatchEnd→checkFeature(TRIGGER_TIME_BORN) 在单位走入+波次横幅后、选技前连播（调研 §9）。
// 原先入场三连只在首次 select 的 settleRoundStartTalents 里跑 ⇒ 演出落到第一回合动作之后。
// settleRoundStartTalents **保留**同三连（全 flag 幂等，二次调用零副作用）——替补等后进场单位
// 的入场钩子继续走"其入场那一包"的 born 步。
function settleBattleStartTalents(units, battleState) {
  applyRelicSharing(units);
  checkEntranceWeather(units, battleState, (battleState && battleState.round) || 1);
  const entranceEffects = checkEntranceTalents(units, battleState, (battleState && battleState.round) || 1) || [];
  return flattenEffects(entranceEffects);
}

// 21680 十香：回合开始前的敌方随机物防 -1。
// 为让玩家在“选技能前”看到 debuff，调用点改为：战斗开始 entry 包 + 每回合末 endTicks 之后
// （endTicks 先恢复上一只的物防并清标记，再为下一回合挂新目标）。返回 effects。
function applyTenkaOpeningDebuff(units, phase) {
  const effects = [];
  (units || []).forEach(u => {
    if (!u || u.hp <= 0 || u.talent !== 21680) return;
    const foes = (units || []).filter(x => x && x.hp > 0 && x.side !== u.side);
    if (!foes.length) return;
    const tar = foes[Math.floor(Math.random() * foes.length)];
    tar.statLevels = tar.statLevels || {};
    const oldLv = tar.statLevels[103] || 0;
    const newLv = Math.max(-6, oldLv - 1);
    const realDelta = newLv - oldLv;
    tar.statLevels[103] = newLv;
    tar.phy_def_lv = newLv;
    tar.tohkaDefLowered = true;
    tar.tohkaTargeted = true;
    if (realDelta !== 0) effects.push({
      trigger_count: 0, atk_servant_id: u.id, src_servant_id: u.id, tar_servant_ids: [tar.id],
      src_type: 1, src_id: 21680, id: 20003,
      effect_phase: phase != null ? phase : 7,
      change_type: 100000, change_value: [encodeAttrVal(103, realDelta, newLv)], remove_round: 0,
    });
  });
  return effects;
}

// 10432 羁绊连环：解析并执行「青龙/朱雀/玄武 立即释放最后技能」的额外行动。
// map_fight 调用后把结果下发为独立 fight_list（有技能动画与伤害数字）；无合法目标返回 null。
function bondChainCast(actor, targets, allUnits, actIndex, battleState) {
  const HOLY = new Set([1543031, 1542032, 1541033]);
  const t = (targets || []).find(x => x && x.hp > 0 && HOLY.has(Number(x.type)));
  if (!t) return null;
  const sid = Number(t.lastUsedSkill) || 0;
  if (!sid || sid === 10432) return null;
  const tcfg = skillCfg(sid);
  if (!tcfg) return null;
  const friend = isFriendEff(tcfg.effType);
  const pool = (allUnits || []).filter(u => u && u.hp > 0 && u.side === (friend ? t.side : (t.side === 0 ? 1 : 0)));
  if (!pool.length) return null;
  const main = pool[Math.floor(Math.random() * pool.length)];
  let tt = targetsOfEff(tcfg.effType, t.side, allUnits, main, t, tcfg.id);
  if (!tt.length) tt = friend ? [t] : [main];
  const results = settleSkill(t, tcfg, tt, allUnits, null, actIndex, battleState) || [];
  const effects = [];
  if (results.wakeEffects && results.wakeEffects.length) effects.push(...flattenEffects(results.wakeEffects));
  const se = applySkillEffects(t, tcfg, tt, allUnits, actIndex, battleState) || [];
  if (se.length) effects.push(...se);
  const tal = checkTalentsAfterSkill(t, tcfg, tt, results, allUnits, actIndex, battleState) || [];
  if (tal.length) effects.push(...tal);
  return { castBy: t.id, skillId: sid, results, effects, pp: ((t.skills || []).find(x => Number(x.id) === sid) || {}).pp || 0 };
}

module.exports = {
  natureOf, stepOf, stepOfStar, phyleOf, natureRelate, naturePer, MAGIC_ARROW, ABSORB_TALENT_NATURE,
  calcAttrs, skillCfg, buildSkillPool, defaultSkills, buildUsingPool, aiUsable, targetsOfEff, resolveTargetPos, isFriendEff, aiChoose, allyChoose, bestAttackChoice, choiceForSkill, estDamageOf, aiChooseDeep, autoChoose, normalizeWeatherState, validateBattleState,
  settleSkill, sortActors, applySkillPriorities, SKILL_PRIO_TABLE, skillChanceMul, NATURE_WEEK, feelCritBonus, feelHitBonus,
  attrLvMul, hitDodgeLvMul, effectiveSpeed, initUnitBattleState,
  applySkillEffects, checkUnitCanAct, settleRoundEndTicks, settleRoundStartTalents, settleBattleStartTalents,
  RELIC_ROUND_HEAL, splitEffectByTarget, sanitizeEffectTargets, isZeroAttrChange, flattenEffects, gainStat,
  featureFxEffect, FX_23090, FX_23100, FX_23120,
  PROP_CODES, PROP_ATTR_NAMES, PROP_FEATURE_IDS, BUFF_IDS, BUFF_FEATURE_IDS,
  encodeAttrVal, encodeBuffVal, getSkillRule,
  FIGHT_EXTRA, CRIT_STAGE_RATES, critRateOfStage,
  WEATHER_IDS, hasNuwaAura, checkTalentsAfterSkill,
  SOUND_SKILL_IDS, isSoundSkill,
  isPunchSkill, applyRelicSharing, unitSkillNatures, isNyxNightTime, isDayTime, NATURE_TO_WEATHER, checkEntranceWeather,
  checkEntranceTalents,
  talentOf, talentInfoOf, talentRuleOf,
  BID_LEFT_BASE, BID_RIGHT_BASE, newBidAllocator, isWireBid,
  elementAwakeOf, elementExclusiveOf, elementExclusiveBehavior, applyExclusiveCastEffects, elementReplacesBase,
  healReceivedMul, isSupportSkillCfg, aiUsableList, bondChainCast, applyTenkaOpeningDebuff,
};
