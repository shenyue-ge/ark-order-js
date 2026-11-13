// 战斗修复本地验证：目标解析 / 兴奋的秘泉(10168) 生效链路 / 其他辅助技范围统计
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FC = require(path.join(ROOT, 'data/fight_core.js'));
const SE = require(path.join(ROOT, 'data/skill_effect_data.js'));
const { SKILLS } = require(path.join(ROOT, 'data/skill_data.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } }

function mkUnit(o) {
  const u = Object.assign({
    id: 1, side: 0, pos: [-1, 0], hp: 1000, maxHp: 1000,
    attrs: { hp: 1000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 },
    statLevels: {}, buffs: {}, skills: [], type: 10001, nature: 1, level: 50, talent: 0,
    dmgMul: 0, selfMit: 0, teamMit: 0, dodge: 0, critLv: 0, critMul: 0, critMit: 0, immuneCrit: false,
    natMul: {}, weekMul: 0, relicId: 0,
  }, o);
  FC.initUnitBattleState(u);
  return u;
}
const briefPosOf = tile => (tile[0] + 500) * 1000 + (tile[1] + 500);

console.log('== 1) 目标格解析 resolveTargetPos ==');
{
  const a1 = mkUnit({ id: 1, pos: [-1, 0] });
  const a2 = mkUnit({ id: 2, pos: [-2, 1] });
  const e1 = mkUnit({ id: 11, side: 1, pos: [1, 0] });
  const e2 = mkUnit({ id: 12, side: 1, pos: [2, 1] });
  ok('己方池：选中 -2,1 命中 a2', FC.resolveTargetPos([a1, a2], briefPosOf([-2, 1])) === a2);
  ok('敌方池：选中 2,1 命中 e2', FC.resolveTargetPos([e1, e2], briefPosOf([2, 1])) === e2);
  ok('己方池：不误命中敌方坐标', FC.resolveTargetPos([a1], briefPosOf([1, 0])) === null || FC.resolveTargetPos([a1], briefPosOf([1, 0])).id === a1.id);
  ok('镜像兜底：同 y 反号（isRightSide 翻转）', FC.resolveTargetPos([mkUnit({ id: 3, pos: [-1, 0] })], briefPosOf([1, 0])) !== null);
  ok('无匹配 → null', FC.resolveTargetPos([a1, a2], briefPosOf([-3, 2])) === null);
}

console.log('== 2) 兴奋的秘泉 cast：flag / 速度翻倍 ==');
let caster, mate, foe;
{
  caster = mkUnit({ id: 1, pos: [-1, 0], type: 3143004, skills: [{ id: 10168, pp: 10 }] });
  mate = mkUnit({ id: 2, pos: [-2, 1], hp: 1000, maxHp: 1000 });
  foe = mkUnit({ id: 11, side: 1, pos: [1, 0] });
  const cfg = FC.skillCfg(10168);
  const all = [caster, mate, foe];
  const baseSpeed = FC.effectiveSpeed(mate, all, { round: 1, weather: null });
  const eff = FC.applySkillEffects(caster, cfg, [mate], all, 0, { round: 1, weather: null });
  ok('目标获得 exciteSpringRounds=3', mate.exciteSpringRounds === 3, mate.exciteSpringRounds);
  ok('记录 dmgMul=2 / speedMul=2', mate.exciteSpringDmgMul === 2 && mate.exciteSpringSpeedMul === 2);
  const spd = FC.effectiveSpeed(mate, all, { round: 1, weather: null });
  ok('速度翻倍', spd === baseSpeed * 2, { baseSpeed, spd });
  ok('未选中的队友不受影响', foe.exciteSpringRounds === undefined);
  console.log('  cast effects:', JSON.stringify(eff).slice(0, 200));
}

console.log('== 3) 回合末扣血 20% × 3 回合 + 到期 ==');
{
  const ids11501 = [], ids11502 = [];
  let hpTrace = [mate.hp];
  for (let r = 1; r <= 3; r++) {
    const eff = FC.settleRoundEndTicks([caster, mate, foe], { round: r, weather: null });
    hpTrace.push(mate.hp);
    for (const e of eff) {
      if (Number(e.id) === 11501) ids11501.push({ r, ct: e.change_type, v: e.change_value, tar: e.tar_servant_ids });
      if (Number(e.id) === 11502) ids11502.push({ r, ct: e.change_type, tar: e.tar_servant_ids });
    }
  }
  ok('HP 轨迹 1000→800→600→400', JSON.stringify(hpTrace) === JSON.stringify([1000, 800, 600, 400]), hpTrace);
  ok('每回合都有 11501 扣血事件', ids11501.length === 3, ids11501);
  ok('扣血事件 change_type=200000 且值为 -200', ids11501.every(e => e.ct === 200000 && e.v[0] === -200), ids11501[0]);
  ok('第 3 回合到期发 11502', ids11502.length === 1 && ids11502[0].r === 3, ids11502);
  ok('到期后 rounds 清零', (mate.exciteSpringRounds || 0) === 0);
  const spdAfter = FC.effectiveSpeed(mate, [caster, mate, foe], { round: 4, weather: null });
  ok('到期后速度恢复', spdAfter === 100, spdAfter);
}

console.log('== 4) 伤害翻倍（settleSkill 实战对比）==');
{
  function run(spring) {
    const oldRnd = Math.random;
    Math.random = () => 0.5; // 固定 roll/暴击判定，便于精确比较乘区
    const atk = mkUnit({ id: 5, side: 0, pos: [-1, 0], type: 10001, nature: 1, skills: [{ id: 10016, pp: 30 }] });
    const tgt = mkUnit({ id: 15, side: 1, pos: [1, 0], type: 10001, nature: 1, hp: 5000, maxHp: 5000, attrs: { hp: 5000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 } });
    if (spring) { atk.exciteSpringRounds = 3; atk.exciteSpringDmgMul = 2; }
    const st = { round: 1, weather: null, selMap: {} };
    try {
      FC.settleSkill(atk, FC.skillCfg(10016), [tgt], [atk, tgt], null, 0, st);
    } catch (e) { console.log('  settleSkill err:', e.message); }
    Math.random = oldRnd;
    return 5000 - Math.round(tgt.hp);
  }
  const d0 = run(false), d1 = run(true);
  ok('未加 buff 伤害 >0', d0 > 0, d0);
  ok('加了兴奋的秘泉伤害≈2 倍（取整误差 ≤1）', Math.abs(d1 - d0 * 2) <= 1, { d0, d1 });
}

console.log('== 5) 其他单体辅助技能：目标修复影响面 + 缺实现清单 ==');
{
  const EFF_FRIEND_ONE = new Set([2002, 2103, 2005, 2008, 2012, 2013, 2014, 2015, 2016]);
  const isFriend = e => e === 2001 || EFF_FRIEND_ONE.has(e) || [2011, 2099, 2004].includes(e);
  const single = [], missing = [];
  for (const id of Object.keys(SKILLS)) {
    const s = SKILLS[id];
    if (Number(s.type) !== 3) continue;
    const e = Number(s.effType);
    if (!(e === 2001 || EFF_FRIEND_ONE.has(e))) continue;
    single.push(s);
    if (!SE.getSkillRule(Number(id)) && !(Number(s.healPct) > 0)) missing.push(s);
  }
  console.log('  单体辅助/自身技总数:', single.length, '其中缺实现:', missing.length);
  console.log('  缺实现清单:', missing.map(s => `${s.id}:${s.name}`).join('、 '));
  ok('10168 已在缺实现清单修复后不再缺席', !missing.some(s => s.id === 10168));
  ok('10168 有 rule', !!SE.getSkillRule(10168));
}

console.log('\n结果: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
