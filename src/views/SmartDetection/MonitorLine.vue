<template>
  <!-- 线路监控模块 -->
  <div class="monitor-line">
    <!-- 标题区域 -->
    <div class="header">
      <topHeader />
    </div>
    <!-- 运维信息区域 -->
    <div class="omInfor">
      <LineOMInfor />
    </div>
    <!-- 地铁线路区域 -->
    <div class="metroLine">
      <MetroLine />
    </div>
    <!-- 表格数据区域 -->
    <div class="dataTables">
      <DataTables />
    </div>
  </div>
</template>

<script setup>
import topHeader from '@/components/topHeader.vue'
import LineOMInfor from '@/components/LineOMInfor.vue'
import MetroLine from '@/components/MetroLine2.vue'
import DataTables from '@/components/DataTables.vue'
</script>

<style scoped>
.monitor-line {
  width: 100%;
  height: 100vh;
  box-sizing: border-box;
  padding: 10px;
  display: flex;
  flex-direction: column;
}
.omInfor {
  width: 100%;
  height: 25%;
}
.metroLine {
  width: 100%;
  height: 30%;
  margin-top: 20px;
}
.dataTables {
  width: 100%;
  flex: 1;
}
</style>