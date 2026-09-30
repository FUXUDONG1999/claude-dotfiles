#!/usr/bin/env node
// 假 claude 可执行文件：按 FAKE_CLAUDE_MODE 环境变量输出预录的 stream-json 行，用于集成测试。
const mode = process.env.FAKE_CLAUDE_MODE ?? 'normal';

function writeLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  if (mode === 'normal') {
    writeLine({ type: 'system', subtype: 'init', session_id: 'fake-session-001' });
    writeLine({ type: 'assistant', message: { content: [{ type: 'text', text: '先分析依赖。' }] } });
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 60));
    writeLine({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
    writeLine({ type: 'assistant', message: { content: [{ type: 'text', text: '测试通过，修复完成。' }] } });
    writeLine({
      type: 'result',
      result: '修复完成：3 个用例全部通过。',
      session_id: 'fake-session-001',
      total_cost_usd: 0.02,
      duration_ms: 300,
      is_error: false,
    });
    process.exit(0);
  }

  if (mode === 'hang') {
    writeLine({ type: 'system', subtype: 'init', session_id: 'fake-session-hang' });
    writeLine({ type: 'assistant', message: { content: [{ type: 'text', text: '思考中…' }] } });
    // 用 setInterval 占住事件循环：pending Promise 不会阻止 Node 进程退出
    setInterval(() => {}, 1 << 30);
  }

  if (mode === 'fail') {
    process.stderr.write('fake claude crashed: invalid credentials\n');
    process.exit(2);
  }
}

await main();
