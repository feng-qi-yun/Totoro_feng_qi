'use client';

import { useState } from 'react';
import { Eye, Pencil, Trash2 } from 'lucide-react';
import { manageImportedRoutes } from '../lib/api';

const PADDING = 8;

function toLocalPoints(points) {
  return (points || [])
    .map(point => ({ latitude: Number(point.latitude), longitude: Number(point.longitude) }))
    .filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
}

// 官方路线 + 导入路线的俯视图（纯本地 SVG，不依赖地图瓦片）
function RoutePreview({ official, imported }) {
  const all = [...toLocalPoints(official), ...toLocalPoints(imported)];
  if (all.length < 3) return null;

  const lats = all.map(point => point.latitude);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const scale = Math.cos(lat * Math.PI / 180);
  const xs = all.map(point => point.longitude * scale);
  const ys = lats;
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const size = 100 - PADDING * 2;
  const ratio = Math.max(Math.max(...xs) - minX || 1e-6, Math.max(...ys) - minY || 1e-6);

  const project = points => toLocalPoints(points).map(point => {
    const x = (point.longitude * scale - minX) / ratio * size + PADDING;
    const y = size - (point.latitude - minY) / ratio * size + PADDING;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const officialShape = project(official);
  const importedShape = project(imported);
  if (!importedShape.length) return null;
  const [startX, startY] = importedShape[0].split(',');

  return <svg className="route-preview" viewBox="0 0 100 100" role="img" aria-label="路线俯视图">
    {officialShape.length > 2 && <polygon
      points={officialShape.join(' ')}
      fill="none" stroke="#9aa3ad" strokeWidth="1" strokeDasharray="2 2"
    />}
    <polygon points={importedShape.join(' ')} fill="none" stroke="#c8372d" strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx={startX} cy={startY} r="2" fill="#c8372d" />
  </svg>;
}

export default function ImportedRoutesPanel({ task, userToken, routes, onRefresh }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [importRouteId, setImportRouteId] = useState('');

  const officialRoutes = task?.runPointList || [];
  const taskRoutes = routes.filter(item => officialRoutes.some(route => route.pointId === item.lineId));
  const importOptions = officialRoutes.filter(route => !taskRoutes.some(item => item.lineId === route.pointId));
  const previewLine = taskRoutes.find(item => item.lineId === previewId);
  const previewOfficial = previewLine
    ? officialRoutes.find(route => route.pointId === previewLine.lineId)?.pointList
    : [];

  async function submit(action, payload) {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      const result = await manageImportedRoutes(action, payload);
      if (!result.success) throw new Error(result.message || '操作失败');
      if (result.routes) onRefresh(result.routes);
      return result;
    } catch (caught) {
      setError(caught.message);
      return null;
    } finally {
      setBusy('');
    }
  }

  async function handleImport() {
    const routeId = importRouteId || importOptions[0]?.pointId || '';
    if (!routeId) return;
    setBusy('import');
    setError('');
    setNotice('');
    try {
      const result = await manageImportedRoutes('import', { token: userToken, route_id: routeId });
      if (!result.success) throw new Error(result.message || '导入失败');
      if (result.routes) onRefresh(result.routes);
      setPreviewId(routeId);
      setImportRouteId('');
      setNotice(`已从 ${result.imported.recordDate || '最近一次'} 的记录导入「${result.imported.label}」`
        + `（一圈约 ${Math.round(result.imported.lapMeters)} 米 / ${result.imported.pointCount} 点）`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy('');
    }
  }

  async function handleRename(item) {
    const label = window.prompt(`给「${item.label}」起个新名字`, item.label);
    if (!label || !label.trim()) return;
    const result = await submit('rename', { line_id: item.lineId, label });
    if (result) setNotice(`已重命名为「${result.route.label}」`);
  }

  async function handleDelete(item) {
    if (!window.confirm(`删除「${item.label}」？删除后只能用真实记录重新导入。`)) return;
    const result = await submit('delete', { line_id: item.lineId });
    if (result) {
      if (previewId === item.lineId) setPreviewId('');
      setNotice(`已删除「${item.label}」`);
    }
  }

  return <section className="command-panel imported-routes" aria-label="导入路线管理">
    <div className="top-strip">
      <div className="panel-copy"><p className="block-label">Imported route</p><h2>导入路线</h2></div>
    </div>
    <p className="limit-note">
      由你真实跑过的记录导出的跑步线。生成轨迹沿它走，但上报给学校的仍是官方路线
      （路线 ID、路线点、拟合度都按官方路线算）。
    </p>

    {taskRoutes.length === 0 && <p className="limit-note">当前任务还没有导入路线。</p>}

    {taskRoutes.map(item => <article className="run-result result-block" key={item.lineId}>
      <div>
        <strong>{item.label}</strong>
        <span>
          {item.baseRouteName || '官方路线'}
          {item.recordDate ? ` · 来自 ${item.recordDate} 的记录` : ''}
          {item.lapMeters ? ` · 一圈约 ${Math.round(item.lapMeters)} 米` : ''}
          {` · ${item.pointCount} 点`}
        </span>
      </div>
      <div className="inline-stats">
        <button className="icon-text-button" type="button" disabled={Boolean(busy)}
          onClick={() => setPreviewId(previewId === item.lineId ? '' : item.lineId)}>
          <Eye size={16} />{previewId === item.lineId ? '收起' : '查看路线'}
        </button>
        <button className="icon-text-button" type="button" disabled={Boolean(busy)} onClick={() => handleRename(item)}>
          <Pencil size={16} />重命名
        </button>
        <button className="icon-text-button" type="button" disabled={Boolean(busy)} onClick={() => handleDelete(item)}>
          <Trash2 size={16} />删除
        </button>
      </div>
      {previewId === item.lineId && <div className="route-preview-block">
        <RoutePreview official={previewOfficial} imported={item.pointList} />
        <p className="limit-note">红色实线＝导入的跑步线，灰色虚线＝官方路线折线，红点＝起点。</p>
      </div>}
    </article>)}

    {importOptions.length > 0 && <div className="form-grid">
      <label><span>从真实记录导入</span>
        <select value={importRouteId || importOptions[0].pointId} onChange={event => setImportRouteId(event.target.value)}>
          {importOptions.map(route => <option key={route.pointId} value={route.pointId}>{route.pointName}</option>)}
        </select>
      </label>
      <button className="action-button" type="button" disabled={Boolean(busy) || !userToken} onClick={handleImport}>
        {busy === 'import' ? '正在导入…' : '从最近一次真实跑步记录导入'}
      </button>
      <p className="limit-note">会读取你最近一次跑过这条官方路线的记录轨迹，推出跑步线并保存到本机（不会提交任何成绩）。</p>
    </div>}

    {error && <p className="result-block error" role="alert">{error}</p>}
    {notice && <p className="limit-note" role="status">{notice}</p>}
  </section>;
}
