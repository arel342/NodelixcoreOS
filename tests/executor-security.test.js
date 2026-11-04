'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createExecutor = require('../executor');

test('executor: command contents are not written to server logs', async () => {
    const logs = [];
    const envMap = { TERMINAL_ENABLED: 'true', TERMINAL_TIMEOUT_S: '5', TERMINAL_MAX_OUTPUT_KB: '32' };
    const executor = createExecutor({
        env: (key, fallback) => envMap[key] === undefined ? fallback : envMap[key],
        log: message => logs.push(String(message))
    });
    try {
        const marker = 'Nodelix-Secret-Command-Marker';
        const result = await executor.execute({ cmd: `printf ${marker}`, timeoutMs: 5000 });
        assert.equal(result.ok, true, result.stderr);
        assert.match(result.output, new RegExp(marker));
        assert.ok(!logs.join('\\n').includes(marker), 'raw command content must not appear in logs');
        assert.ok(logs.some(line => /command accepted/.test(line)));
    } finally {
        executor.killAll('test_cleanup');
        executor.stopSweeper();
    }
});
