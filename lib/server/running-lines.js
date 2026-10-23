import fs from 'node:fs';
import path from 'node:path';

// 「真实跑步线」：由真实跑步记录按圈相位折叠 + 等弧长采样导出（见 scripts/derive-running-line.js）。
// 官方路线折线常常只是操场/区域的边界，和正常人实际跑的跑道不是同一条线；
// 有导出线时生成轨迹沿导出线走，但拟合度仍对官方路线计算（学校就是那么算的）。
const DEFAULT_DIR = path.join(process.cwd(), 'local-data', 'derived-routes');
const cache = new Map();

export function runningLineDir(options = {}) {
  return options.dir || process.env.TOTORO_RUNNING_LINE_DIR || DEFAULT_DIR;
}

export function loadRunningLine(routeId, options = {}) {
  const id = String(routeId || '');
  if (!id) return null;
  const file = path.join(runningLineDir(options), `${id}.json`);
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs) return cached.line;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      cache.set(file, { mtimeMs: undefined, line: null });
      return null;
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  const pointList = Array.isArray(parsed?.pointList) ? parsed.pointList : null;
  if (!pointList || pointList.length < 4) throw new Error(`跑步线文件无效: ${file}`);
  const stat = fs.statSync(file);
  cache.set(file, { mtimeMs: stat.mtimeMs, line: pointList });
  return pointList;
}

export function withRunningLine(route, options = {}) {
  if (!route?.pointId) return route;
  // 界面选「导入路线N」时会显式带 importedLineId；否则按路线 id 自动匹配
  const runningLine = loadRunningLine(route.importedLineId || route.pointId, options);
  return runningLine ? { ...route, runningLine } : route;
}

// 列出本机可用的导入路线（界面下拉框用）。命名为「导入路线1/2…」，按文件名排序保持稳定。
export function listRunningLines(options = {}) {
  const dir = runningLineDir(options);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const parsedEntries = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort()
    .flatMap(name => {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        return [];   // 损坏的文件跳过，且不占用编号
      }
      const pointList = Array.isArray(parsed?.pointList) ? parsed.pointList : [];
      if (pointList.length < 4) return [];
      return [{
        lineId: String(parsed.routeId || name.replace(/\.json$/, '')),
        baseRouteId: String(parsed.routeId || name.replace(/\.json$/, '')),
        baseRouteName: String(parsed.routeName || ''),
        lapMeters: Number(parsed.lapMeters) || null,
        pointCount: pointList.length,
      }];
    });
  // 标签带上关联的官方路线名：「天目湖-西操场-导入路线1」，看清是这条官方路线的导入版本
  return parsedEntries.map((item, index) => ({
    ...item,
    label: `${item.baseRouteName ? `${item.baseRouteName}-` : ''}导入路线${index + 1}`,
  }));
}
