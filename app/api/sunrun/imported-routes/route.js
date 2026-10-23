import { json, readJson } from '../../../../lib/server/http.js';
import {
  deleteRunningLine,
  importRunningLine,
  renameRunningLine,
} from '../../../../lib/server/imported-routes.js';
import { listRunningLines } from '../../../../lib/server/running-lines.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

// 导入路线的接口：action = list（默认）/ rename / delete / import
export async function POST(request) {
  const headers = { 'Cache-Control': 'no-store' };
  const body = await readJson(request);
  const action = String(body?.action || 'list');
  try {
    if (action === 'rename') {
      const route = renameRunningLine(body.line_id, body.label);
      return json({ success: true, route, routes: listRunningLines() }, { headers });
    }
    if (action === 'delete') {
      const route = deleteRunningLine(body.line_id);
      return json({ success: true, route, routes: listRunningLines() }, { headers });
    }
    if (action === 'import') {
      const imported = await importRunningLine({
        token: body.token,
        routeId: body.route_id,
        recordId: body.record_id || '',
        days: body.days,
        spacingMeters: body.spacing,
      });
      return json({ success: true, imported, routes: listRunningLines() }, { headers });
    }
    return json({ success: true, routes: listRunningLines() }, { headers });
  } catch (error) {
    return json({ success: false, message: error.message }, { status: 400, headers });
  }
}
