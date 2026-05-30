---
name: algorithm
description: 通用算法与数据结构实现参考——排序、搜索、动态规划、图算法、字符串处理的多语言惯用写法和模板代码（Python/C++/Java/Go/Cangjie）
mode: code
---

# 通用算法与数据结构实现参考

本技能提供常见算法的多语言惯用实现模板，帮助选择正确的数据结构和编写高效代码。

---

## 1. 数据结构选型速查

| 需求 | Python | C++ | Java | Go |
| --- | --- | --- | --- | --- |
| 动态数组 | `list` | `vector<T>` | `ArrayList<T>` | `[]T` slice |
| 双端队列 | `collections.deque` | `deque<T>` | `ArrayDeque<T>` | 自定义/slice |
| 栈 | `list` (append/pop) | `stack<T>` | `Deque<T>` | `[]T` slice |
| 哈希表 | `dict` | `unordered_map<K,V>` | `HashMap<K,V>` | `map[K]V` |
| 哈希集合 | `set` | `unordered_set<T>` | `HashSet<T>` | `map[T]bool` |
| 有序映射 | `SortedDict` (sortedcontainers) | `map<K,V>` | `TreeMap<K,V>` | 无内置 |
| 优先队列/堆 | `heapq` (最小堆) | `priority_queue<T>` (最大堆) | `PriorityQueue<T>` (最小堆) | `container/heap` |
| 链表 | 自定义 class | `list<T>` | `LinkedList<T>` | 自定义 struct |

**注意事项**：
- Python `heapq` 是最小堆，取最大用 `-val` 或 `heapq.nlargest`
- C++ `priority_queue` 默认最大堆，最小堆用 `priority_queue<T, vector<T>, greater<T>>`
- Java `PriorityQueue` 默认最小堆，最大堆传 `Comparator.reverseOrder()`
- Go `container/heap` 需要自定义实现 `heap.Interface`

---

## 2. 排序

### 2.1 内置排序 + 自定义比较

```python
# Python — 稳定排序
arr.sort(key=lambda x: x[1])           # 按第二元素升序
arr.sort(key=lambda x: (-x[1], x[0]))  # 先按第二元素降序，再按第一元素升序
```

```cpp
// C++ — 不稳定排序 (std::sort) / 稳定排序 (std::stable_sort)
sort(arr.begin(), arr.end(), [](const auto& a, const auto& b) {
    return a.second < b.second;  // 按第二元素升序
});
```

```java
// Java — 稳定排序 (TimSort)
Arrays.sort(arr, (a, b) -> a[1] - b[1]);  // 按第二元素升序
// 注意：a - b 在极值时可能溢出，安全写法用 Integer.compare(a, b)
```

```go
// Go — 不稳定排序 / sort.SliceStable 稳定
sort.Slice(arr, func(i, j int) bool {
    return arr[i][1] < arr[j][1]
})
```

### 2.2 堆 / Top-K

```python
import heapq
# Top K 大元素 — 维护大小为 K 的最小堆
top_k = heapq.nlargest(k, arr)
# 等价手动维护
heap = []
for val in arr:
    heapq.heappush(heap, val)
    if len(heap) > k:
        heapq.heappop(heap)
```

```cpp
// C++ — 最小堆取 Top K 大
priority_queue<int, vector<int>, greater<int>> minHeap;
for (int val : arr) {
    minHeap.push(val);
    if (minHeap.size() > k) minHeap.pop();
}
```

---

## 3. 搜索

### 3.1 二分查找模板

```python
# Python — bisect 模块
import bisect
idx = bisect.bisect_left(arr, target)   # 第一个 >= target 的位置
idx = bisect.bisect_right(arr, target)  # 第一个 > target 的位置

# 手写二分
def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = lo + (hi - lo) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
```

```cpp
// C++ — lower_bound / upper_bound
auto it = lower_bound(arr.begin(), arr.end(), target);  // >= target
auto it2 = upper_bound(arr.begin(), arr.end(), target); // > target
```

```java
// Java — Arrays.binarySearch (精确查找) 或手写
int idx = Arrays.binarySearch(arr, target);  // 找不到返回负值
```

### 3.2 双指针

```python
# 两数之和（排序数组）
def two_sum_sorted(arr, target):
    left, right = 0, len(arr) - 1
    while left < right:
        s = arr[left] + arr[right]
        if s == target:
            return [left, right]
        elif s < target:
            left += 1
        else:
            right -= 1
    return []
```

### 3.3 滑动窗口

```python
# 最长不重复子串
def length_of_longest_substring(s):
    seen = {}
    left = 0
    max_len = 0
    for right, ch in enumerate(s):
        if ch in seen and seen[ch] >= left:
            left = seen[ch] + 1
        seen[ch] = right
        max_len = max(max_len, right - left + 1)
    return max_len
```

---

## 4. 动态规划

### 4.1 一维 DP 模板

```python
# 爬楼梯 / 斐波那契
def climb_stairs(n):
    if n <= 2:
        return n
    prev2, prev1 = 1, 2
    for _ in range(3, n + 1):
        prev2, prev1 = prev1, prev1 + prev2
    return prev1
```

### 4.2 二维 DP — 最长公共子序列

```python
def lcs(a, b):
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i-1] == b[j-1]:
                dp[i][j] = dp[i-1][j-1] + 1
            else:
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
    return dp[m][n]
```

### 4.3 背包问题

```python
# 0-1 背包（一维滚动优化）
def knapsack(weights, values, capacity):
    dp = [0] * (capacity + 1)
    for i in range(len(weights)):
        for w in range(capacity, weights[i] - 1, -1):  # 逆序遍历！
            dp[w] = max(dp[w], dp[w - weights[i]] + values[i])
    return dp[capacity]
```

---

## 5. 图算法

### 5.1 邻接表 + BFS

```python
from collections import deque, defaultdict

def bfs(graph, start):
    visited = {start}
    queue = deque([start])
    result = []
    while queue:
        node = queue.popleft()
        result.append(node)
        for neighbor in graph[node]:
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)
    return result
```

### 5.2 DFS（递归 + 迭代）

```python
# 递归 DFS
def dfs(graph, node, visited=None):
    if visited is None:
        visited = set()
    visited.add(node)
    for neighbor in graph[node]:
        if neighbor not in visited:
            dfs(graph, neighbor, visited)
    return visited

# 迭代 DFS（显式栈，避免递归深度限制）
def dfs_iterative(graph, start):
    visited = set()
    stack = [start]
    while stack:
        node = stack.pop()
        if node in visited:
            continue
        visited.add(node)
        for neighbor in graph[node]:
            if neighbor not in visited:
                stack.append(neighbor)
    return visited
```

### 5.3 Dijkstra 最短路径

```python
import heapq

def dijkstra(graph, start):
    dist = {start: 0}
    heap = [(0, start)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist.get(u, float('inf')):
            continue
        for v, w in graph[u]:
            nd = d + w
            if nd < dist.get(v, float('inf')):
                dist[v] = nd
                heapq.heappush(heap, (nd, v))
    return dist
```

### 5.4 拓扑排序（Kahn 算法）

```python
from collections import deque

def topological_sort(graph, in_degree):
    queue = deque([u for u in in_degree if in_degree[u] == 0])
    result = []
    while queue:
        u = queue.popleft()
        result.append(u)
        for v in graph[u]:
            in_degree[v] -= 1
            if in_degree[v] == 0:
                queue.append(v)
    return result if len(result) == len(in_degree) else []  # 有环则为空
```

### 5.5 并查集

```python
class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x):
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])  # 路径压缩
        return self.parent[x]

    def union(self, x, y):
        px, py = self.find(x), self.find(y)
        if px == py:
            return False
        if self.rank[px] < self.rank[py]:
            px, py = py, px
        self.parent[py] = px
        if self.rank[px] == self.rank[py]:
            self.rank[px] += 1
        return True
```

---

## 6. 字符串

### 6.1 KMP 模式匹配

```python
def kmp_search(text, pattern):
    n, m = len(text), len(pattern)
    lps = [0] * m
    # 构建 LPS 数组
    length, i = 0, 1
    while i < m:
        if pattern[i] == pattern[length]:
            length += 1
            lps[i] = length
            i += 1
        elif length:
            length = lps[length - 1]
        else:
            lps[i] = 0
            i += 1
    # 搜索
    i = j = 0
    results = []
    while i < n:
        if text[i] == pattern[j]:
            i += 1
            j += 1
        if j == m:
            results.append(i - j)
            j = lps[j - 1]
        elif i < n and text[i] != pattern[j]:
            j = lps[j - 1] if j else 0
            if j == 0 and text[i] != pattern[0]:
                i += 1
    return results
```

### 6.2 回文判断

```python
def is_palindrome(s):
    return s == s[::-1]

# 最长回文子串（中心扩展）
def longest_palindrome(s):
    def expand(l, r):
        while l >= 0 and r < len(s) and s[l] == s[r]:
            l -= 1
            r += 1
        return s[l+1:r]

    best = ""
    for i in range(len(s)):
        odd = expand(i, i)
        even = expand(i, i + 1)
        best = max(best, odd, even, key=len)
    return best
```

---

## 7. 树

### 7.1 二叉树遍历（迭代）

```python
# 中序遍历（迭代）
def inorder(root):
    result, stack = [], []
    node = root
    while node or stack:
        while node:
            stack.append(node)
            node = node.left
        node = stack.pop()
        result.append(node.val)
        node = node.right
    return result

# 层序遍历
from collections import deque
def level_order(root):
    if not root:
        return []
    result, queue = [], deque([root])
    while queue:
        level = []
        for _ in range(len(queue)):
            node = queue.popleft()
            level.append(node.val)
            if node.left:
                queue.append(node.left)
            if node.right:
                queue.append(node.right)
        result.append(level)
    return result
```

---

## 8. 常见陷阱速查

| 陷阱 | 说明 | 解决方案 |
| --- | --- | --- |
| 整数溢出 | C/C++/Java `int` 范围 ±2.1×10⁹ | 用 `long long`/`long`，或检测溢出 |
| 浮点精度 | `0.1 + 0.2 != 0.3` | 用 `abs(a-b) < 1e-9` 比较，或用整数运算 |
| 二分 mid 溢出 | `(lo+hi)/2` 大值时溢出 | 用 `lo + (hi-lo)/2` |
| Python 递归深度 | 默认 1000 层 | `sys.setrecursionlimit()` 或改迭代 |
| 浅拷贝 vs 深拷贝 | `list[:]` 是浅拷贝，嵌套列表需 `copy.deepcopy` | 二维数组用 `[row[:] for row in matrix]` |
| HashMap 遍历时修改 | Java/Go 遍历时修改会异常或未定义行为 | 收集要删的 key，遍历后删 |
| C++ 迭代器失效 | `erase` 后迭代器失效 | 使用 `it = container.erase(it)` |
| off-by-one | 左闭右开 vs 左闭右闭 | 明确 `[lo, hi)` 或 `[lo, hi]` 并保持一致 |

---

## 9. 复杂度速查

| 算法 | 时间 | 空间 |
| --- | --- | --- |
| 二分查找 | O(log n) | O(1) |
| 归并排序 | O(n log n) | O(n) |
| 快速排序 | O(n log n) 平均 | O(log n) 栈 |
| 堆排序 | O(n log n) | O(1) |
| BFS/DFS | O(V+E) | O(V) |
| Dijkstra (二叉堆) | O((V+E) log V) | O(V) |
| 并查集 (路径压缩+按秩) | ~O(α(n)) ≈ O(1) | O(n) |
| 动态规划 | 取决于状态数 × 转移 | 取决于状态数 |

---

## 9. Stress Test 对拍模板

在暴力解和优化解之间进行随机数据对拍，快速发现 WA：

```python
import random

def brute_force(arr, target):
    """暴力解——保证正确但可能慢"""
    # ... 你的暴力实现 ...
    pass

def optimized(arr, target):
    """优化解——需要验证"""
    # ... 你的优化实现 ...
    pass

def stress_test(iterations=10000, max_n=20, max_val=100):
    for i in range(iterations):
        n = random.randint(1, max_n)
        arr = [random.randint(-max_val, max_val) for _ in range(n)]
        target = random.randint(-max_val, max_val)
        expected = brute_force(arr[:], target)
        actual = optimized(arr[:], target)
        if expected != actual:
            print(f"MISMATCH at iteration {i}:")
            print(f"  input:    arr={arr}, target={target}")
            print(f"  expected: {expected}")
            print(f"  actual:   {actual}")
            return
    print(f"OK — {iterations} random tests passed")

stress_test()
```

```cpp
// C++ stress test 骨架
#include <bits/stdc++.h>
using namespace std;
mt19937 rng(42);

int brute(vector<int>& a) { /* 暴力解 */ return 0; }
int solve(vector<int>& a) { /* 优化解 */ return 0; }

int main() {
    for (int t = 0; t < 100000; t++) {
        int n = rng() % 20 + 1;
        vector<int> a(n);
        for (auto& x : a) x = rng() % 201 - 100;
        auto a2 = a;
        int exp = brute(a), got = solve(a2);
        if (exp != got) {
            cout << "MISMATCH at t=" << t << endl;
            for (int x : a) cout << x << " ";
            cout << "\nexpected=" << exp << " got=" << got << endl;
            return 1;
        }
    }
    cout << "OK" << endl;
}
```

---

## 10. 进阶数据结构

### 10.1 Trie（前缀树）

```python
class TrieNode:
    def __init__(self):
        self.children = {}
        self.is_end = False

class Trie:
    def __init__(self):
        self.root = TrieNode()

    def insert(self, word):
        node = self.root
        for ch in word:
            if ch not in node.children:
                node.children[ch] = TrieNode()
            node = node.children[ch]
        node.is_end = True

    def search(self, word):
        node = self._find(word)
        return node is not None and node.is_end

    def starts_with(self, prefix):
        return self._find(prefix) is not None

    def _find(self, s):
        node = self.root
        for ch in s:
            if ch not in node.children:
                return None
            node = node.children[ch]
        return node
```

### 10.2 单调栈

```python
def next_greater_elements(nums):
    """返回每个元素右边第一个更大元素的索引，不存在则 -1"""
    n = len(nums)
    result = [-1] * n
    stack = []  # 存索引，栈内元素对应值单调递减
    for i in range(n):
        while stack and nums[stack[-1]] < nums[i]:
            result[stack.pop()] = i
        stack.append(i)
    return result
```

### 10.3 线段树（区间求和 + 单点修改）

```python
class SegTree:
    def __init__(self, data):
        self.n = len(data)
        self.tree = [0] * (4 * self.n)
        self._build(data, 1, 0, self.n - 1)

    def _build(self, data, node, lo, hi):
        if lo == hi:
            self.tree[node] = data[lo]
            return
        mid = (lo + hi) // 2
        self._build(data, node * 2, lo, mid)
        self._build(data, node * 2 + 1, mid + 1, hi)
        self.tree[node] = self.tree[node * 2] + self.tree[node * 2 + 1]

    def update(self, idx, val, node=1, lo=0, hi=None):
        if hi is None:
            hi = self.n - 1
        if lo == hi:
            self.tree[node] = val
            return
        mid = (lo + hi) // 2
        if idx <= mid:
            self.update(idx, val, node * 2, lo, mid)
        else:
            self.update(idx, val, node * 2 + 1, mid + 1, hi)
        self.tree[node] = self.tree[node * 2] + self.tree[node * 2 + 1]

    def query(self, ql, qr, node=1, lo=0, hi=None):
        if hi is None:
            hi = self.n - 1
        if ql <= lo and hi <= qr:
            return self.tree[node]
        if qr < lo or hi < ql:
            return 0
        mid = (lo + hi) // 2
        return self.query(ql, qr, node * 2, lo, mid) + \
               self.query(ql, qr, node * 2 + 1, mid + 1, hi)
```

### 10.4 树状数组（BIT）

```python
class BIT:
    def __init__(self, n):
        self.n = n
        self.tree = [0] * (n + 1)

    def update(self, i, delta):
        i += 1  # 1-indexed
        while i <= self.n:
            self.tree[i] += delta
            i += i & (-i)

    def prefix_sum(self, i):
        i += 1
        s = 0
        while i > 0:
            s += self.tree[i]
            i -= i & (-i)
        return s

    def range_sum(self, l, r):
        return self.prefix_sum(r) - (self.prefix_sum(l - 1) if l > 0 else 0)
```

---

## 11. 非刷题练习指引

算法能力不仅来自做题，以下练习同样有效：

| 练习类型 | 示例 | 关注点 |
| --- | --- | --- |
| 实现经典结构 | 写一个完整的 LRU Cache / MinHeap / Trie，带单测 | 接口设计、边界、测试覆盖 |
| 读代码分析 | 分析 Python `list.sort` (TimSort) 或 Go `sort.Slice` 源码 | 均摊/最坏复杂度推导 |
| 接口选型 | 给定「10M 条记录、按时间范围查询」，比较 B-Tree vs Hash vs 跳表 | 读写比、空间、缓存友好度 |
| 复杂度预算 | 给定 n ≤ 10⁶ 和 2s 时限，推导允许的最大复杂度 | 常数因子、I/O 瓶颈 |
