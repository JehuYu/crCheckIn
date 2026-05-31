@echo off
echo ========================================
echo  crCheckIn 服务器启动脚本
echo ========================================
echo.
echo 正在启动服务器...
echo 服务器地址: http://127.0.0.1:5001/
echo 学生签到: http://127.0.0.1:5001/student
echo 教师登录: http://127.0.0.1:5001/teacher/classes
echo.
echo 默认管理员账号: admin
echo 默认密码: abc123
echo.
echo 按 Ctrl+C 停止服务器
echo ========================================
echo.

node server.js