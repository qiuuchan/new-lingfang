# -*- coding: utf-8 -*-
# =============================================================================
# 计算器插件入口（runtime_type: python）
# -----------------------------------------------------------------------------
# PySide6 (Qt6) 实现的桌面计算器。由桌面壳 start_plugin 命令在
# %LOCALAPPDATA%/QianXia/python-venvs 下创建 venv（首次会从清华镜像 pip install
# PySide6，约 80MB，几十秒；之后幂等跳过）后 detached 运行 `python -u main.py`。
#
# 界面在进程自己弹出的独立窗口（平台对 python/nodejs 插件只做启动器 + 进程监视），
# stdin/stdout 不参与交互，故全部交互走 Qt 事件循环。
#
# 仅依赖 PySide6（见 requirements.txt），其余全用标准库。
# =============================================================================

import re
import sys

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication,
    QGridLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

# 显示符号 → Python eval 安全字符的映射。用显示符号让 UI 友好，求值前还原。
_SYM_MAP = {"×": "*", "÷": "/", "−": "-", " ": ""}

# 安全表达式字符集：数字、运算符、括号、小数点。eval 前校验，杜绝注入。
_SAFE_EXPR = re.compile(r"^[0-9+\-*/(). ]*$")

# 按键布局：(文本, 跨列数)。顺序对应网格从上到下、从左到右。
_LAYOUT = [
    ("C", "⌫", "(", ")"),
    ("7", "8", "9", "÷"),
    ("4", "5", "6", "×"),
    ("1", "2", "3", "−"),
    ("0", ".", "=", "+"),
]

# 颜色：等号主色、运算符次色、数字普通色，对应现代计算器视觉惯例。
_QSS = """
QMainWindow { background: #1f2026; }
#display { color: #ffffff; background: #1f2026; }
#expr { color: #9aa0a6; background: #1f2026; }
QPushButton {
    color: #e8eaed; background: #2c2e36; border: none; border-radius: 16px;
    font-size: 22px;
}
QPushButton:pressed { background: #3c3f4a; }
QPushButton#op { color: #f0b429; }
QPushButton#eq { background: #4285f4; color: #ffffff; }
QPushButton#fn { color: #ef5350; }
"""


def _normalize(expr: str) -> str:
    """把显示表达式还原为 Python 可求值的字符串。"""
    out = expr
    for sym, rep in _SYM_MAP.items():
        out = out.replace(sym, rep)
    return out


def evaluate(expr: str) -> str:
    """安全求值：仅允许数字/四则运算符/括号/小数点。返回结果字符串或错误提示。"""
    norm = _normalize(expr)
    if not norm:
        return ""
    if not _SAFE_EXPR.fullmatch(norm):
        return "错误"
    # 结尾是运算符/左括号时，求值会抛异常 → 统一返回错误。
    try:
        value = eval(norm, {"__builtins__": {}}, {})  # noqa: S307 - 已正则白名单校验
    except ZeroDivisionError:
        return "不能除以零"
    except Exception:
        return "错误"
    # 整数结果去掉小数尾零，避免 5.0。
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value)


class Calculator(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("计算器")
        self.setFixedSize(340, 520)
        self._expr = ""
        self._build_ui()
        self.setStyleSheet(_QSS)

    # ------------------------------------------------------------------
    # UI 构建
    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(10)

        # 历史表达式行（小号灰字，显示输入过程）。
        self._expr_label = QLabel("")
        self._expr_label.setObjectName("expr")
        self._expr_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self._expr_label.setFont(QFont("Segoe UI", 14))
        root.addWidget(self._expr_label)

        # 主显示行（大号白字，显示当前结果/输入）。
        self._display = QLabel("0")
        self._display.setObjectName("display")
        self._display.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self._display.setFont(QFont("Segoe UI", 40))
        self._display.setMinimumHeight(80)
        root.addWidget(self._display)

        # 按键网格。
        grid = QGridLayout()
        grid.setSpacing(10)
        for r, row in enumerate(_LAYOUT):
            for c, text in enumerate(row):
                grid.addWidget(self._make_btn(text), r, c)
        root.addLayout(grid)

    def _make_btn(self, text: str) -> QPushButton:
        btn = QPushButton(text)
        btn.setFixedHeight(60)
        # 按角色分类着色：等号 / 运算符 / 功能键 / 数字。
        if text == "=":
            btn.setObjectName("eq")
        elif text in ("÷", "×", "−", "+"):
            btn.setObjectName("op")
        elif text in ("C", "⌫"):
            btn.setObjectName("fn")
        btn.clicked.connect(lambda _checked=False, t=text: self._on_key(t))
        return btn

    # ------------------------------------------------------------------
    # 按键处理
    # ------------------------------------------------------------------
    def _on_key(self, key: str) -> None:
        if key == "C":
            self._expr = ""
            self._refresh("0")
        elif key == "⌫":
            self._expr = self._expr[:-1]
            self._refresh(self._expr or "0")
        elif key == "=":
            result = evaluate(self._expr)
            # 保留上一表达式到小字行，主行显示结果。
            self._expr_label.setText(self._expr + " =" if self._expr else "")
            self._expr = "" if result in ("错误", "不能除以零") else result
            self._display.setText(result if result else "0")
        else:
            self._expr += key
            self._refresh(self._expr)

    def _refresh(self, display: str) -> None:
        self._display.setText(display)
        self._expr_label.setText(self._expr)


def main() -> None:
    app = QApplication(sys.argv)
    app.setApplicationName("计算器")
    win = Calculator()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
