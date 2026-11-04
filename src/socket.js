import { io } from 'socket.io-client';
// 同源连接：开发环境走 Vite 代理（/socket.io），生产环境由 Express 直接托管
const socket = io();
// 暴露到全局，方便控制台调试
window.socket = socket;
export default socket;
