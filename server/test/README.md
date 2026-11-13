# Server battle tests

Pure Node.js unit tests for the battle engine. Run from anywhere:

```bash
node server/test/test_10168.js       # ally target selection + 10168 兴奋的秘泉
node server/test/test_p0_support.js  # P0 support skills
node server/test/test_p1_support.js  # P1 support skills
node server/test/test_p15_support.js # P1.5 AoE support skills
```

They require no game client, no network and no external dependencies.
Each script prints PASS/FAIL and exits non-zero on failure.
