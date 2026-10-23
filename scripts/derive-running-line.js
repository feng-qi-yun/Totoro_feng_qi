#!/usr/bin/env node
// 从真实跑步记录里导出「真实跑步线」：按圈相位折叠 + 等弧长采样，得到一条干净闭合线。
//
// 用途：小程序里的官方路线折线往往只是操场/区域的边界，跟人实际跑的跑道不是同一条线
// （例：天目湖西操场官方折线 572.7 米、实际跑的椭圆跑道 469.8 米，两者相差 10~27 米）。
// 用真实记录导出跑步线后，生成轨迹就能沿着正常人跑的那条线走。
//
// 只读本地文件，不联网。核心计算在 lib/server/running-line-derive.js。
import fs from 'node:fs';
import path from 'node:path';
import { deriveRunningLine } from '../lib/server/running-line-derive.js';

// 兼容既有测试/脚本从本文件导入
export { deriveRunningLine, findLapMeters, sampleLoop } from '../lib/server/running-line-derive.js';

const DEFAULT_INPUT_DIR = path.join(process.cwd(), 'local-data');

function parseArgs(argv) {
  const options = { input: '', recordId: '', spacingMeters: 15, outDir: path.join(DEFAULT_INPUT_DIR, 'derived-routes'), help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;   // pnpm 会把 -- 原样透传过来
    const value = argv[index + 1];
    if (arg === '--record') { options.recordId = value || ''; index += 1; }
    else if (arg === '--spacing') { options.spacingMeters = Math.max(5, Number(value) || 15); index += 1; }
    else if (arg === '--out') { options.outDir = value || options.outDir; index += 1; }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!options.input) options.input = arg;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    console.log(`用法：node scripts/derive-running-line.js <采样结果.json> [--record <记录ID>] [--spacing 15] [--out 目录]

输入是 scripts/sample-real-runs.js --detail --keep-tracks 的产物（含真实轨迹）。
输出 local-data/derived-routes/<路线ID>.json，任务页的路线下拉框会出现「<官方路线名>-导入路线N」。

也可以直接在网页里导入：任务页「导入路线」面板 → 选官方路线 → 从最近一次真实跑步记录导入。`);
    process.exitCode = options.help ? 0 : 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(options.input, 'utf8'));
  const entries = (report.detail || []).filter(item => Array.isArray(item.track) && item.track.length > 1);
  const targets = options.recordId ? entries.filter(item => String(item.recordId) === options.recordId) : entries;
  if (!targets.length) throw new Error('输入文件里没有带轨迹的记录（采样时请加 --keep-tracks）');

  fs.mkdirSync(options.outDir, { recursive: true });
  for (const item of targets) {
    const derived = deriveRunningLine(item.track, { spacingMeters: options.spacingMeters });
    const file = path.join(options.outDir, `${item.routeId}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      derivedFrom: item.recordId,
      routeId: item.routeId,
      routeName: item.routeName,
      generatedAt: new Date().toISOString(),
      ...derived,
    }, null, 1)}\n`);
    console.log(`${item.routeName}（${item.routeId}）`);
    console.log(`  圈长 ${derived.lapMeters}m（折叠散度 ${derived.foldSpreadMeters}m，${derived.laps} 圈）`
      + ` → ${derived.pointList.length} 点 / 每点约 ${derived.spacingMeters}m`);
    console.log(`  已写入 ${path.relative(process.cwd(), file)}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(`导出失败: ${error.message}`);
    process.exitCode = 1;
  }
}
