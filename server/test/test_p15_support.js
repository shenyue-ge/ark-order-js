// P1.5 群体辅助技能验证（纯服务端单元测试）
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FC = require(path.join(ROOT, 'data/fight_core.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
function mk(o) {
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
const cfg = id => FC.skillCfg(id);
const st = (r = 1) => ({ round: r, weather: null, selMap: {} });

console.log('== 10216 星之传承 ==');
{
  const caster = mk({ id: 1, hp: 500, maxHp: 1000 });
  const mate = mk({ id: 2 });
  FC.applySkillEffects(caster, cfg(10216), [caster, mate], [caster, mate], 0, st());
  ok('HP≥40%：全队 2 回合伤害 +30%', caster.teamDmgUpRounds === 2 && caster.teamDmgUpPct === 30 && mate.teamDmgUpPct === 30, { c: caster.teamDmgUpPct, m: mate.teamDmgUpPct });
  const caster2 = mk({ id: 3, hp: 300, maxHp: 1000 });
  const mate2 = mk({ id: 4 });
  FC.applySkillEffects(caster2, cfg(10216), [caster2, mate2], [caster2, mate2], 0, st());
  ok('HP<40%：全队 +60%', mate2.teamDmgUpPct === 60, mate2.teamDmgUpPct);
}

console.log('== 10283 自由的呼吸 ==');
{
  const oldRnd = Math.random;
  Math.random = () => 0; // prop=101, delta=minUp
  const caster = mk({ id: 1, hp: 1000, maxHp: 1000, type: 2742002 });
  const holo = mk({ id: 2, type: 2742002, attrs: { hp: 1000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 } });
  const normal = mk({ id: 3, type: 10001 });
  FC.applySkillEffects(caster, cfg(10283), [caster, holo, normal], [caster, holo, normal], 0, st());
  Math.random = oldRnd;
  ok('损失 15% 最大生命', Math.round(caster.hp) === 850, caster.hp);
  ok('普通誓灵随机能力 +1', (normal.statLevels[101] || 0) === 1, normal.statLevels);
  ok('HOLOLIVE 额外 +1（共 +2）', (holo.statLevels[101] || 0) === 2, holo.statLevels);
}

console.log('== 10291 风之返恩 ==');
{
  const caster = mk({ id: 1, type: 2843002 });
  const helped = mk({ id: 2 });
  const other = mk({ id: 3 });
  caster.supportReceivedLog = { 2: 4 }; // 第4回合 ally 2 对雀儿用过辅助技
  FC.applySkillEffects(caster, cfg(10291), [caster, helped, other], [caster, helped, other], 0, st(5));
  ok('5 回合内辅助过使用者：该 Ally 下次攻击 +60%', Math.abs(helped.nextOutDmgUp - 0.6) < 1e-9, helped.nextOutDmgUp);
  ok('其他 Ally 下次攻击 +30%', Math.abs(other.nextOutDmgUp - 0.3) < 1e-9, other.nextOutDmgUp);
  // 辅助目标记录：普通辅助技对雀儿使用后写入
  const caster2 = mk({ id: 4 }), helper = mk({ id: 5 }), target = mk({ id: 6 });
  FC.applySkillEffects(helper, cfg(10320), [caster2], [caster2, helper, target], 0, st(2));
  ok('辅助技目标记录 supportReceivedLog', caster2.supportReceivedLog && caster2.supportReceivedLog[helper.id] === 2, caster2.supportReceivedLog);
}

console.log('== 10310 宝幡 ==');
{
  const oldRnd = Math.random;
  Math.random = () => 0; // random def -> 103
  const caster = mk({ id: 1 });
  const mate = mk({ id: 2 });
  mate.statLevels = { 101: -2, 102: -1, 103: 0, 104: 0, 105: 0 };
  FC.applySkillEffects(caster, cfg(10310), [caster, mate], [caster, mate], 0, st());
  Math.random = oldRnd;
  ok('清除所有负面能力等级', (mate.statLevels[101] || 0) === 0 && (mate.statLevels[102] || 0) === 0, mate.statLevels);
  ok('随机一项防御 +1', (mate.statLevels[103] || 0) === 1, mate.statLevels);
}

console.log('== 10358 守护灵 ==');
{
  const caster = mk({ id: 1 });
  const mate = mk({ id: 2 });
  FC.applySkillEffects(caster, cfg(10358), [caster, mate], [caster, mate], 0, st());
  ok('全队本回合受伤 -35%', mate.teamDmgDownRounds === 1 && mate.teamDmgDownPct === 35, mate);
  ok('全队受到治疗 +20%', Math.abs(FC.healReceivedMul(mate) - 1.2) < 1e-9, FC.healReceivedMul(mate));
}

console.log('== 10365 生命绽放 ==');
{
  const caster = mk({ id: 1 });
  const a = mk({ id: 2 }); a.lifeSeeds = 2;
  const b = mk({ id: 3 }); b.lifeSeeds = 1;
  const all = [caster, a, b];
  FC.applySkillEffects(caster, cfg(10365), all, all, 0, st());
  ok('己方全体 +10% 护盾', Number(caster.shield) === 100 && Number(a.shield) === 100 && Number(b.shield) === 100, { c: caster.shield, a: a.shield, b: b.shield });
  ok('生命之种全部消耗', (a.lifeSeeds || 0) === 0 && (b.lifeSeeds || 0) === 0);
  const totalLv = [caster, a, b].reduce((s, u) => s + [101, 102, 103, 104, 105].reduce((x, p) => x + (u.statLevels[p] || 0), 0), 0);
  ok('消耗 3 个种子 → 随机 3 项能力 +1', totalLv === 3, totalLv);
}

console.log('\n结果: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
