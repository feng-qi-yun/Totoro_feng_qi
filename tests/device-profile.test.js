import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { defaultDeviceProfile, deviceProfileFromEnv } from '../lib/server/run-data.js';
import { newestDeviceRecord, upsertEnvFile } from '../scripts/detect-device.js';

const tempDir = () => {
  const dir = path.join(import.meta.dirname, '..', 'local-data', `test-device-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

test('device profile comes from .env with a fallback', () => {
  const fallback = deviceProfileFromEnv({});
  assert.equal(fallback, null);
  assert.equal(defaultDeviceProfile({}).phoneInfo, 'Redmi&2602BRT18C&Android 16');

  const configured = defaultDeviceProfile({
    TOTORO_DEVICE_PROFILE: 'Xiaomi&23049RAD8C&Android 15',
    TOTORO_CLIENT_VERSION: '8.0.80',
  });
  assert.equal(configured.phoneInfo, 'Xiaomi&23049RAD8C&Android 15');
  assert.equal(configured.version, '8.0.80');
  assert.equal(configured.deviceModel, 'Xiaomi 23049RAD8C (Android 15)');

  // 型号/系统缺失、或环境变量写错时退回兜底值，而不是生成半个机型
  assert.equal(deviceProfileFromEnv({ TOTORO_DEVICE_PROFILE: 'Xiaomi&23049RAD8C' }), null);
  assert.equal(deviceProfileFromEnv({ TOTORO_DEVICE_PROFILE: '乱写' }), null);
  assert.equal(defaultDeviceProfile({ TOTORO_DEVICE_PROFILE: '乱写' }).phoneInfo, 'Redmi&2602BRT18C&Android 16');
});

test('the newest record with a device wins', () => {
  const records = [
    { id: 'a', evaluateDate: '2026-10-11', phoneInfo: '' },
    { id: 'b', evaluateDate: '2026-09-25', phoneInfo: 'Redmi&2602BRT18C&Android 16', version: '8.0.76' },
    { id: 'c', evaluateDate: '2026-10-15', phoneInfo: 'Xiaomi&23049RAD8C&Android 15', version: '8.0.80' },
  ];
  assert.equal(newestDeviceRecord(records).id, 'c');
  assert.equal(newestDeviceRecord([{ phoneInfo: '' }]), null);
  assert.equal(newestDeviceRecord([]), null);
  assert.equal(newestDeviceRecord(undefined), null);
});

test('writing the device keeps the rest of .env intact', () => {
  const dir = tempDir();
  const file = path.join(dir, '.env');
  try {
    fs.writeFileSync(file, 'SUNRUN_MINIPROGRAM_BASE_URL=https://example.test\nTOTORO_CLIENT_VERSION=8.0.50\n');
    upsertEnvFile(file, { TOTORO_DEVICE_PROFILE: 'Redmi&2602BRT18C&Android 16', TOTORO_CLIENT_VERSION: '8.0.76' });
    const written = fs.readFileSync(file, 'utf8');
    assert.match(written, /SUNRUN_MINIPROGRAM_BASE_URL=https:\/\/example\.test/);
    assert.match(written, /TOTORO_CLIENT_VERSION=8\.0\.76/);
    assert.match(written, /TOTORO_DEVICE_PROFILE=Redmi&2602BRT18C&Android 16/);
    assert.equal(written.match(/TOTORO_CLIENT_VERSION/g).length, 1, '不要写出重复键');

    // 文件不存在时直接创建
    const fresh = path.join(dir, '.env.fresh');
    upsertEnvFile(fresh, { TOTORO_DEVICE_PROFILE: 'vivo&V2307A&Android 15' });
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'TOTORO_DEVICE_PROFILE=vivo&V2307A&Android 15\n');
    fs.rmSync(fresh, { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
