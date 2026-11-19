package com.qundaofeixing.holegame;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat c =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 沉浸式全屏：内容延伸到系统栏后面，隐藏状态栏/导航栏（从屏幕边缘滑入临时显示）
        hideSystemBars();
        // 刘海/挖孔屏：允许内容延伸进缺口区（默认 default 会在刘海处留黑边）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        // 老 ROM 兜底：部分国产 ROM 忽略 InsetsController，用传统 FLAG 一并压住状态栏
        //（targetSdk 35+ 的 Android 15 上此 FLAG 无效但无害，由 InsetsController 生效）
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        // 飞行中保持屏幕常亮
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 启动屏/WebView 初始化抢焦点后系统栏会复活：拿到焦点立即再藏一次
        if (hasFocus) hideSystemBars();
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从后台/任务切换回来时系统栏可能重新出现：再藏一次
        hideSystemBars();
    }
}
