---
name: cangjie-algorithm
description: 仓颉语言算法与数据结构实现参考——排序、搜索、动态规划、图算法、字符串处理、集合操作的惯用写法和模板代码
mode: cangjie
---

# 仓颉算法与数据结构实现参考

## 1. 排序

### 1.1 数组原地排序

```cangjie
import std.collection.*
import std.sort.*

// Array 排序（原地）
var arr: Array<Int64> = [5, 3, 1, 4, 2]
arr.sortBy { a, b => a - b }   // 升序
arr.sortBy { a, b => b - a }   // 降序
```

### 1.2 ArrayList 排序

```cangjie
import std.collection.*

let list = ArrayList<Int64>([3, 1, 4, 1, 5])
// 转为 Array 排序后使用
var arr = list.toArray()
arr.sortBy { a, b => a - b }
```

### 1.3 自定义类型排序

```cangjie
import std.collection.*
import std.sort.*

struct Student {
    let name: String
    let score: Int64
}

var students = [Student("Alice", 90), Student("Bob", 85)]
students.sortBy { a, b => b.score - a.score }  // 按分数降序
```

### 1.4 实现 Comparable 接口

```cangjie
class Point <: Comparable<Point> & Equatable<Point> {
    let x: Int64
    let y: Int64

    public init(x: Int64, y: Int64) {
        this.x = x
        this.y = y
    }

    public func compareTo(other: Point): Int64 {
        if (this.x != other.x) { return this.x - other.x }
        return this.y - other.y
    }

    public operator func ==(other: Point): Bool {
        this.x == other.x && this.y == other.y
    }

    public operator func !=(other: Point): Bool {
        !(this == other)
    }
}
```

## 2. 搜索

### 2.1 二分查找

```cangjie
func binarySearch(arr: Array<Int64>, target: Int64): Int64 {
    var lo: Int64 = 0
    var hi: Int64 = arr.size - 1
    while (lo <= hi) {
        let mid = lo + (hi - lo) / 2
        if (arr[mid] == target) { return mid }
        if (arr[mid] < target) { lo = mid + 1 } else { hi = mid - 1 }
    }
    return -1  // 未找到
}
```

### 2.2 二分查找变体（查找插入位置 / lower_bound）

```cangjie
func lowerBound(arr: Array<Int64>, target: Int64): Int64 {
    var lo: Int64 = 0
    var hi: Int64 = arr.size
    while (lo < hi) {
        let mid = lo + (hi - lo) / 2
        if (arr[mid] < target) { lo = mid + 1 } else { hi = mid }
    }
    return lo
}
```

### 2.3 HashMap 查找

```cangjie
import std.collection.*

let map = HashMap<String, Int64>()
map.put("apple", 3)
let count = map.get("apple") ?? 0  // 不存在时返回默认值 0
```

## 3. 动态规划

### 3.1 一维 DP（斐波那契 / 爬楼梯）

```cangjie
func climbStairs(n: Int64): Int64 {
    if (n <= 2) { return n }
    var prev2: Int64 = 1
    var prev1: Int64 = 2
    for (_ in 3..=n) {
        let cur = prev1 + prev2
        prev2 = prev1
        prev1 = cur
    }
    return prev1
}
```

### 3.2 二维 DP（最长公共子序列）

```cangjie
func lcs(a: String, b: String): Int64 {
    let m = a.size
    let n = b.size
    let runesA = a.toRuneArray()
    let runesB = b.toRuneArray()
    // dp[i][j] = LCS length of a[0..i) and b[0..j)
    var dp = Array<Array<Int64>>(m + 1, { _ => Array<Int64>(n + 1, { _ => 0 }) })
    for (i in 1..=m) {
        for (j in 1..=n) {
            if (runesA[i - 1] == runesB[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1
            } else {
                dp[i][j] = if (dp[i - 1][j] > dp[i][j - 1]) { dp[i - 1][j] } else { dp[i][j - 1] }
            }
        }
    }
    return dp[m][n]
}
```

### 3.3 背包问题

```cangjie
func knapsack(weights: Array<Int64>, values: Array<Int64>, capacity: Int64): Int64 {
    let n = weights.size
    var dp = Array<Int64>(capacity + 1, { _ => 0 })
    for (i in 0..n) {
        for (w in (weights[i]..=capacity).step(-1)) {
            let candidate = dp[w - weights[i]] + values[i]
            if (candidate > dp[w]) { dp[w] = candidate }
        }
    }
    return dp[capacity]
}
```

## 4. 链表与树

### 4.1 链表节点（必须用 class，struct 不能自引用）

```cangjie
class ListNode {
    var value: Int64
    var next: ?ListNode

    public init(value: Int64) {
        this.value = value
        this.next = None
    }
}

// 遍历链表
func traverse(head: ?ListNode): Unit {
    var cur = head
    while (true) {
        match (cur) {
            case Some(node) =>
                println("${node.value}")
                cur = node.next
            case None => break
        }
    }
}
```

### 4.2 二叉树

```cangjie
class TreeNode {
    var value: Int64
    var left: ?TreeNode
    var right: ?TreeNode

    public init(value: Int64) {
        this.value = value
        this.left = None
        this.right = None
    }
}

// 中序遍历
func inorder(node: ?TreeNode): Unit {
    match (node) {
        case Some(n) =>
            inorder(n.left)
            println("${n.value}")
            inorder(n.right)
        case None => ()
    }
}

// 树的最大深度
func maxDepth(node: ?TreeNode): Int64 {
    match (node) {
        case None => 0
        case Some(n) =>
            let l = maxDepth(n.left)
            let r = maxDepth(n.right)
            1 + (if (l > r) { l } else { r })
    }
}
```

## 5. 图算法

### 5.1 邻接表表示

```cangjie
import std.collection.*

// 图用 HashMap<Int64, ArrayList<Int64>> 表示邻接表
func buildGraph(edges: Array<(Int64, Int64)>): HashMap<Int64, ArrayList<Int64>> {
    let graph = HashMap<Int64, ArrayList<Int64>>()
    for ((u, v) in edges) {
        if (graph.get(u) == None) { graph.put(u, ArrayList<Int64>()) }
        if (graph.get(v) == None) { graph.put(v, ArrayList<Int64>()) }
        (graph.get(u) ?? ArrayList<Int64>()).append(v)
        (graph.get(v) ?? ArrayList<Int64>()).append(u)  // 无向图
    }
    return graph
}
```

### 5.2 BFS

```cangjie
import std.collection.*

func bfs(graph: HashMap<Int64, ArrayList<Int64>>, start: Int64): ArrayList<Int64> {
    let visited = HashSet<Int64>()
    let queue = ArrayList<Int64>()
    let result = ArrayList<Int64>()

    queue.append(start)
    visited.put(start)

    while (queue.size > 0) {
        let node = queue[0]
        queue.remove(0)
        result.append(node)

        let neighbors = graph.get(node) ?? ArrayList<Int64>()
        for (next in neighbors) {
            if (!visited.contains(next)) {
                visited.put(next)
                queue.append(next)
            }
        }
    }
    return result
}
```

### 5.3 DFS

```cangjie
import std.collection.*

func dfs(graph: HashMap<Int64, ArrayList<Int64>>, start: Int64): ArrayList<Int64> {
    let visited = HashSet<Int64>()
    let result = ArrayList<Int64>()

    func visit(node: Int64): Unit {
        if (visited.contains(node)) { return }
        visited.put(node)
        result.append(node)
        let neighbors = graph.get(node) ?? ArrayList<Int64>()
        for (next in neighbors) {
            visit(next)
        }
    }

    visit(start)
    return result
}
```

## 6. 字符串处理

### 6.1 字符串基本操作

```cangjie
let s = "hello world"
let len = s.size                    // 长度
let sub = s[0..5]                   // 子串 "hello" (左闭右开)
let upper = s.toAsciiUpper()        // 转大写
let parts = s.split(" ")           // 分割为 Array<String>
let contains = s.contains("world") // 是否包含
let idx = s.indexOf("world")      // 查找位置，返回 ?Int64
```

### 6.2 字符遍历

```cangjie
let s = "hello"
// 按 Rune 遍历
for (ch in s) {
    println("${ch}")
}

// 转为 Rune 数组后按索引操作
let runes = s.toRuneArray()
let first = runes[0]  // 'h'
```

### 6.3 字符串构建

```cangjie
// 频繁拼接场景使用 StringBuilder
import std.io.*

let sb = StringBuilder()
for (i in 0..10) {
    sb.append("${i} ")
}
let result = sb.toString()
```

## 7. 常用算法模式速查

| 算法模式 | 仓颉惯用写法 |
| --- | --- |
| 交换两个变量 | `var a = 1; var b = 2; let tmp = a; a = b; b = tmp` |
| 取最大/最小值 | `let mx = if (a > b) { a } else { b }` |
| 绝对值 | `let abs = if (x >= 0) { x } else { -x }` |
| 整数除法向下取整 | 仓颉整数除法默认截断（同 C），向下取整自然满足 |
| 取模 | `a % b`（结果符号与被除数相同） |
| 幂运算 | `import std.math.*; let p = pow(2.0, 10.0)` (Float64) |
| 无穷大 | `import std.math.*; let INF = Int64.Max` |
| 二维数组初始化 | `Array<Array<Int64>>(m, { _ => Array<Int64>(n, { _ => 0 }) })` |
| 数组复制 | `let copy = Array<Int64>(arr.size, { i => arr[i] })` |
| 字符转数字 | `let digit = (ch.toInt64()) - ('0'.toInt64())` |
| 数字转字符串 | `"${number}"` 或 `number.toString()` |

## 8. 性能注意事项

- `Array<T>` 固定长度，访问 O(1)，不能增删元素；`ArrayList<T>` 动态长度，尾部 append O(1) 摊还，头部 insert/remove O(n)
- struct 赋值/传参会拷贝整个值；大型数据结构（链表、树、图节点）应使用 class
- HashMap/HashSet 查找、插入、删除均为平均 O(1)；Key 类型必须实现 Hashable & Equatable
- 递归深度大时注意栈溢出（仓颉协程栈默认较小）；可改为迭代+显式栈
- 字符串拼接在循环中用 StringBuilder 代替 `+`/`${}`，避免 O(n^2) 复杂度
- `0..n` Range 迭代是零分配的，优先使用
