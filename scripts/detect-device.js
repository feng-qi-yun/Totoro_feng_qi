#!/usr/bin/env node
// 读出你上一次跑步用的机型与客户端版本，写进 .env。
//
// 学校按记录保存 phoneInfo/version，随机或写死的机型会与你的历史记录不一致，
// 所以新用户第一次使用时跑一下这个脚本即可。
//
// 只调用只读接口（selectSunRunDayScantronList），不提交任何成绩。
import fs from 'node:fs';
import nextEnv from '@next/env';
import { fetchMiniProgram } from '../lib/server/miniprogram-fetch.js';
import { serviceFromBody } from '../lib/server/sunrun-service.js';
import { loginWithToken } from '../lib/server/token-login.js';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const USAGE = `用法：
  TOTORO_TOKEN=<小程序 Token> node scripts/detect-device.js [选项]

选项：
  --token <token>    小程序 Token（也可用环境变量 TOTORO_TOKEN）
  --days <n>         最多向前查找多少天，默认 30
  --env-file <路径>  写入的配置文件，默认 .env
  --print            只打印，不写文件
  --help`;

function parseArgs(argv) {
  const options = { token: process.env.TOTORO_TOKEN || '', days: 30, envFile: '.env', print: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;   // pnpm 会把 -- 原样透传过来
    if (arg === '--token') { options.token = argv[index + 1] || ''; index += 1; }
    else if (arg === '--days') { options.days = Math.max(1, Number(argv[index + 1]) || 30); index += 1; }
    else if (arg === '--env-file') { options.envFile = argv[index + 1] || '.env'; index += 1; }
    else if (arg === '--print') options.print = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

// 取最近一条带机型的记录（学校的字段是 phoneInfo / version）
export function newestDeviceRecord(records) {
  const candidates = (records || []).filter(record => String(record?.phoneInfo || '').includes('&'));
  if (!candidates.length) return null;
  return candidates
    .slice()
    .sort((left, right) => String(right.evaluateDate || '').localeCompare(String(left.evaluateDate || '')))[0];
}

// 就地更新 .env：已有键改值，没有的追加，其余行原样保留
export function upsertEnvFile(file, values) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing.length ? existing.replace(/\n$/, '').split('\n') : [];
  const pending = new Map(Object.entries(values));
  const updated = lines.map(line => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  fs.writeFileSync(file, `${updated.join('\n')}\n`);
  return updated.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.token) {
    console.error('缺少 Token：设置 TOTORO_TOKEN 环境变量或使用 --token。');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const profile = await loginWithToken(options.token);
  const tasks = await serviceFromBody({
    token: profile.token, stu_number: profile.stuNumber, campus_id: profile.campusId,
  }).getSunrunTasks();
  console.log(`账号 ${profile.stuName || profile.stuNumber} | 任务 ${tasks.length} 个`);

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  let found = null;
  for (let offset = 0; offset < options.days && !found; offset += 1) {
    const date = formatter.format(new Date(Date.now() - offset * 86400000));
    for (const task of tasks) {
      const response = await fetchMiniProgram('/wxxcx/sunrun/selectSunRunDayScantronList', {
        method: 'POST', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${options.token}` },
        body: JSON.stringify({
          snCode: profile.stuNumber, evaluateDate: date, paperId: task.taskId, token: options.token,
        }),
      }, { timeoutMs: 20000 });
      const result = await response.json().catch(() => null);
      const records = ['data', 'body', 'list', 'obj'].map(key => result?.[key]).find(Array.isArray) || [];
      found = newestDeviceRecord(records);
      if (found) break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  if (!found) {
    console.error(`最近 ${options.days} 天没有找到带机型的记录。先用小程序真实跑一次再来。`);
    process.exitCode = 1;
    return;
  }
  const device = String(found.phoneInfo);
  const version = String(found.version || '').trim();
  console.log(`最近一次记录 ${found.evaluateDate}（${found.id || '无ID'}）`);
  console.log(`  机型 phoneInfo = ${device}`);
  console.log(`  客户端 version = ${version || '(空)'}`);

  const values = { TOTORO_DEVICE_PROFILE: device };
  if (version) values.TOTORO_CLIENT_VERSION = version;
  if (options.print) {
    console.log('\n只打印模式，未写入文件。请在 .env 中设置：');
    for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
    return;
  }
  upsertEnvFile(options.envFile, values);
  console.log(`\n已写入 ${options.envFile}：`);
  for (const [key, value] of Object.entries(values)) console.log(`  ${key}=${value}`);
  console.log('\n生成轨迹时会用这个机型（学校按记录保存 phoneInfo，机型要与你的历史记录一致）。');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(`获取机型失败: ${error.message}`);
    process.exitCode = 1;
  });
}
