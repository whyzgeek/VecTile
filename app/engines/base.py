"""
Shared Engine protocol and parameter schema types.
Each engine exposes:
  - name:         display name
  - description:  one-line description
  - param_schema: list of param descriptors (drives UI control rendering).
                  A descriptor may carry `visible_when` ({other_param: [values]}):
                  the UI only shows it while every listed param has one of those values.
  - vectorize(image_path, params) -> SVG string
"""
from typing import Protocol, runtime_checkable


@runtime_checkable
class Engine(Protocol):
    name: str
    description: str
    param_schema: list  # list of ParamDescriptor dicts

    def vectorize(self, image_path: str, params: dict) -> str:
        ...


def int_param(name, label, default, min_val, max_val, step=1, hint="", visible_when=None):
    return {
        "name": name, "label": label, "type": "int",
        "default": default, "min": min_val, "max": max_val, "step": step, "hint": hint,
        "visible_when": visible_when,
    }


def float_param(name, label, default, min_val, max_val, step=0.1, hint="", visible_when=None):
    return {
        "name": name, "label": label, "type": "float",
        "default": default, "min": min_val, "max": max_val, "step": step, "hint": hint,
        "visible_when": visible_when,
    }


def select_param(name, label, default, options, hint="", visible_when=None):
    return {
        "name": name, "label": label, "type": "select",
        "default": default, "options": options, "hint": hint,
        "visible_when": visible_when,
    }


def bool_param(name, label, default, hint="", visible_when=None):
    return {
        "name": name, "label": label, "type": "bool",
        "default": default, "hint": hint,
        "visible_when": visible_when,
    }
