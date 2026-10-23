import fs from 'node:fs';
import path from 'node:path';
import { fetchMiniProgram } from './miniprogram-fetch.js';
import { deriveRunningLine } from './running-line-derive.js';
import { runningLineDir } from './running-lines.js';
import { serviceFromBody } from './sunrun-service.js';
import { loginWithToken } from './token-login.js';

// 导入路线的增删改：文件都在 local-data/derived-routes/<路线ID>.json
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_LABEL = 40;
const MAX_DAYS = 120;

function lineFile(lineId, options = {}) {
  const id = String(lineId || '');
  if (!SAFE_ID.test(id)) throw new Error('路线 ID 不合法');
  return path.join(runningLineDir(options), `${id}.json`);
}

function readLine(lineId, options = {}) {
  const file = lineFile(lineId, options);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('导入路线不存在');
    throw error;
  }
  try {
    return { file, data: JSON.parse(raw) };
  } catch {
    throw new Error('导入路线文件已损坏');
  }
}

function writeLine(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 1)}\n`);
  fs.renameSync(temporary, file);
}

function normalizeLabel(value) {
  const label = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim();
  if (!label) throw new Error('路线名称不能为空');
  if ([...label].length > MAX_LABEL) throw new Error(`路线名称不能超过 ${MAX_LABEL} 个字`);
  return label;
}

export function renameRunningLine(lineId, label, options = {}) {
  const { file, data } = readLine(lineId, options);
  data.label = normalizeLabel(label);
  data.updatedAt = new Date().toISOString();
  writeLine(file, data);
  return { lineId: String(lineId), label: data.label };
}

export function deleteRunningLine(lineId, options = {}) {
  const file = lineFile(lineId, options);
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('导入路线不存在');
    throw error;
  }
  return { lineId: String(lineId) };
}

// 从「最近一次跑过这条官方路线的记录」里取真实轨迹，推导跑步线并保存
export async function importRunningLine({
  token, routeId, recordId = '', days = 60, spacingMeters = 15,
}, options = {}) {
  const id = String(routeId || '');
  if (!SAFE_ID.test(id)) throw new Error('请选择要导入的官方路线');
  if (!token) throw new Error('缺少小程序接口 Token');

  const loadProfile = options.loadProfile || (value => loginWithToken(value));
  const profile = await loadProfile(token);
  const loadTasks = options.loadTasks || (async () => serviceFromBody({
    token: profile.token,
    stu_number: profile.stuNumber,
    campus_id: profile.campusId,
  }).getSunrunTasks());
  const tasks = await loadTasks();
  const task = (tasks || []).find(item => (item.runPointList || []).some(route => String(route.pointId) === id));
  const officialRoute = task?.runPointList.find(route => String(route.pointId) === id);
  if (!officialRoute) throw new Error('当前任务里没有这条官方路线');

  const track = options.loadTrack
    ? await options.loadTrack({ task, routeId: id, recordId })
    : await fetchRealTrack({ token: profile.token, stuNumber: profile.stuNumber, task, routeId: id, recordId, days });
  if (!track?.points?.length) throw new Error('没有找到这条路线带轨迹的记录，先用小程序真实跑一次');

  let derived;
  try {
    derived = deriveRunningLine(track.points, { spacingMeters });
  } catch (error) {
    throw new Error(`这条记录推不出跑步线：${error.message}`);
  }

  const file = lineFile(id, options);
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* 首次导入 */ }
  const label = previous?.label || `${officialRoute.pointName}-导入路线${nextIndex(options)}`;

  writeLine(file, {
    derivedFrom: track.recordId,
    recordDate: track.recordDate,
    routeId: id,
    routeName: officialRoute.pointName,
    label,
    generatedAt: new Date().toISOString(),
    ...derived,
  });
  return {
    lineId: id,
    label,
    routeName: officialRoute.pointName,
    recordId: track.recordId,
    recordDate: track.recordDate,
    lapMeters: derived.lapMeters,
    pointCount: derived.pointList.length,
  };
}

// 同目录已有几个有效文件，用来给新导入的路线编号
function nextIndex(options = {}) {
  const dir = runningLineDir(options);
  let count = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (Array.isArray(parsed?.pointList) && parsed.pointList.length >= 4) count += 1;
      } catch { /* 跳过损坏文件 */ }
    }
  } catch { /* 目录不存在 */ }
  return count + 1;
}

async function fetchRealTrack({ token, stuNumber, task, routeId, recordId, days }) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const todayStart = Date.now();
  const limit = Math.min(MAX_DAYS, Math.max(1, Number(days) || 60));
  for (let offset = 0; offset < limit; offset += 1) {
    const date = formatter.format(new Date(todayStart - offset * 86400000));
    let records = [];
    try {
      const response = await fetchMiniProgram('/wxxcx/sunrun/selectSunRunDayScantronList', {
        method: 'POST', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json;charset=UTF-8', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ snCode: stuNumber, evaluateDate: date, paperId: task.taskId, token }),
      }, { timeoutMs: 20000 });
      const result = await response.json().catch(() => null);
      records = ['data', 'body', 'list', 'obj'].map(key => result?.[key]).find(Array.isArray) || [];
    } catch {
      continue;
    }
    const matches = records.filter(record => String(record?.lineId || '') === routeId
      && String(record?.routeItudes || '').includes(','));
    const chosen = recordId
      ? matches.find(record => String(record.id) === String(recordId))
      : matches[0];
    if (chosen) {
      return {
        recordId: String(chosen.id || ''),
        recordDate: String(chosen.evaluateDate || date),
        points: parseTrack(chosen.routeItudes),
      };
    }
  }
  return null;
}

// 学校的轨迹是「经度,纬度,时间;…」字符串
function parseTrack(value) {
  const points = [];
  for (const item of String(value || '').split(';')) {
    const [longitude, latitude] = item.split(',');
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ latitude: lat, longitude: lon });
  }
  return points;
}
