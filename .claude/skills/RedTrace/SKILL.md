```markdown
# RedTrace Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns and conventions used in the RedTrace Python codebase. You'll learn how to structure files, write imports and exports, follow commit message conventions, and organize tests. This guide is ideal for contributors aiming for consistency and maintainability in RedTrace projects.

## Coding Conventions

### File Naming
- Use **kebab-case** for all file names.
  - **Example:** `trace-handler.py`, `data-processor.py`

### Import Style
- Use **relative imports** within the package.
  - **Example:**
    ```python
    from .utils import parse_data
    from .models import TraceModel
    ```

### Export Style
- Use **named exports** by defining `__all__` in modules.
  - **Example:**
    ```python
    __all__ = ['TraceHandler', 'process_trace']
    ```

### Commit Messages
- Follow the **conventional commit** format.
- Use the `feat` prefix for new features.
- Keep messages concise (average: 28 characters).
  - **Example:**  
    ```
    feat: add trace filtering logic
    ```

## Workflows

### Adding a New Feature
**Trigger:** When implementing a new capability or module  
**Command:** `/add-feature`

1. Create a new Python file using kebab-case (e.g., `new-feature.py`).
2. Use relative imports for dependencies within the package.
3. Define named exports via `__all__` if applicable.
4. Write or update tests in a corresponding `*.test.*` file.
5. Commit changes with a `feat:` prefix and a concise description.

### Writing Tests
**Trigger:** When adding or updating functionality  
**Command:** `/write-test`

1. Create or update a test file matching the pattern `*.test.*` (e.g., `trace-handler.test.py`).
2. Implement test cases for the new or modified code.
3. Use the preferred (but currently undetected) testing framework syntax.
4. Run tests to ensure correctness before committing.

## Testing Patterns

- Test files follow the `*.test.*` naming convention (e.g., `parser.test.py`).
- The specific testing framework is not detected; follow existing patterns or consult project maintainers.
- Place test files alongside the modules they test or in a dedicated test directory if present.

**Example:**
```python
# trace-handler.test.py
from .trace-handler import TraceHandler

def test_trace_handler_initialization():
    handler = TraceHandler()
    assert handler is not None
```

## Commands
| Command        | Purpose                                      |
|----------------|----------------------------------------------|
| /add-feature   | Scaffold and commit a new feature            |
| /write-test    | Create or update a test file for your module |
```
