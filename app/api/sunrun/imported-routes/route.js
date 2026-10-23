import { json } from '../../../../lib/server/http.js';
import { listRunningLines } from '../../../../lib/server/running-lines.js';

export const runtime = 'nodejs';

// 列出本机由真实记录导出的「导入路线」，供任务页的路线下拉框使用
export async function POST() {
  try {
    return json({ success: true, routes: listRunningLines() });
  } catch (error) {
    return json({ success: false, message: `读取导入路线失败: ${error.message}` }, { status: 500 });
  }
}
