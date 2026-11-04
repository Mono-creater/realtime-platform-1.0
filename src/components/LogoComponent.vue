<template>
  <!-- 左上角品牌标识：仅展示本平台自有品牌，不再挂任何运营单位 LOGO（避免"套壳"观感） -->
  <div class="logos">
    <div class="brand-logo">
      <div class="brand-logo-img" style="width: 34px; height: 34px"></div>
      <div class="brand-text">
        <span class="brand-name">驭弓大师</span>
        <span class="brand-sub">地铁车辆智慧运维平台</span>
      </div>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.logos {
  font-family: 'FZYTJW', sans-serif;
  color: #fff;
  padding-left: 14px;
  padding-top: 14px;
}
.brand-logo {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand-logo-img {
  background-image: url('@/assets/images/yg_logo.png');
  background-size: 100% 100%;
  background-repeat: no-repeat;
  flex-shrink: 0;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.brand-name {
  font-size: 20px;
  font-weight: 600;
}
.brand-sub {
  font-size: 11px;
  color: #8fb3d9;
  letter-spacing: 1px;
}
</style>
