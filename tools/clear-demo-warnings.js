#!/usr/bin/env node
/**
 * tools/clear-demo-warnings.js —— 一键清理演示告警
 *
 * 仅删除备注带 [演示数据] 标记的记录（demo-warnings.js 写入），
 * 不会触碰任何真实采集数据。用于正式实验/演示前还原干净状态。
 *
 * 用法：
 *   node tools/clear-demo-warnings.js        # 清理演示告警
 *   node tools/clear-demo-warnings.js --dry  # 仅查看将删除的记录，不执行
 */

'use strict';

try { process.loadEnvFile(); } catch { /* 无 .env 时忽略 */ }

const { PrismaClient } = require('@prisma/client');
const { DEMO_MARK, clearDemoWarnings } = require('../demo-warnings');

(async () => {
    const dryRun = process.argv.includes('--dry');
    const prisma = new PrismaClient();
    try {
        const rows = await prisma.warningHistory.findMany({
            where: { remark: { startsWith: DEMO_MARK } },
            orderBy: { time: 'desc' },
        });

        if (rows.length === 0) {
            console.log('ℹ️ 未发现演示告警，无需清理');
            return;
        }

        console.log(`🔍 找到 ${rows.length} 条演示告警：`);
        rows.forEach((r) => {
            console.log(`   id=${r.id}  ${r.time.toISOString().slice(0, 16).replace('T', ' ')}  ` +
                `${r.code}  ${r.content}  ${r.worker}`);
        });

        if (dryRun) {
            console.log('\n(dry-run) 未执行删除。去掉 --dry 即可实际清理。');
            return;
        }

        const n = await clearDemoWarnings(prisma);
        console.log(`\n✅ 已清理 ${n} 条演示告警（真实采集数据未受影响）`);
    } catch (err) {
        console.error('❌ 清理失败:', err.message);
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect();
    }
})();
