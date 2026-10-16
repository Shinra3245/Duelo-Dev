"""Referencias privadas del catálogo: se ejecutan únicamente dentro de la VM del juez."""

from bisect import bisect_left
from collections import deque
from heapq import heappop, heappush
import sys


def solve(slug: str, data: list[str]) -> str:
    if slug == "parentesis":
        stack: list[str] = []
        for char in data[0]:
            if char in "([{":
                stack.append(char)
            elif not stack or stack.pop() != dict(zip(")]}", "([{"))[char]:
                return "INVALIDO"
        return "INVALIDO" if stack else "VALIDO"
    if slug == "palindromo":
        return "SI" if data[0] == data[0][::-1] else "NO"
    if slug == "contar-vocales":
        return str(sum(char in "aeiou" for char in data[0]))
    if slug == "invertir-palabra":
        return data[0][::-1]
    if slug == "suma-digitos":
        return str(sum(map(int, data[0])))
    if slug == "subsecuencia-comun":
        previous = [0] * (len(data[1]) + 1)
        for char in data[0]:
            current = [0] * len(previous)
            for j, other_char in enumerate(data[1], 1):
                current[j] = (
                    previous[j - 1] + 1 if char == other_char else max(previous[j], current[j - 1])
                )
            previous = current
        return str(previous[-1])
    if slug in ("camino-corto", "cuadrado-unos"):
        rows, columns = map(int, data[:2])
        grid = data[2:]
        if slug == "cuadrado-unos":
            previous = [0] * (columns + 1)
            best = 0
            for row in grid:
                current = [0] * (columns + 1)
                for j, cell in enumerate(row, 1):
                    if cell == "1":
                        current[j] = 1 + min(previous[j], previous[j - 1], current[j - 1])
                        best = max(best, current[j])
                previous = current
            return str(best)
        start_cell = next((r, c) for r in range(rows) for c in range(columns) if grid[r][c] == "S")
        grid_distance = {start_cell: 0}
        pending = deque([start_cell])
        while pending:
            r, c = pending.popleft()
            if grid[r][c] == "E":
                return str(grid_distance[r, c])
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if (
                    0 <= nr < rows
                    and 0 <= nc < columns
                    and grid[nr][nc] != "#"
                    and (nr, nc) not in grid_distance
                ):
                    grid_distance[nr, nc] = grid_distance[r, c] + 1
                    pending.append((nr, nc))
        return "-1"

    values = list(map(int, data))
    n = values[0]
    if slug == "contar-pares":
        return str(sum(value % 2 == 0 for value in values[1:]))
    if slug == "mayor-posicion":
        best = max(values[1:])
        return f"{best} {values[1:].index(best) + 1}"
    if slug == "reloj-segundos":
        return str(n * 3600 + values[1] * 60 + values[2])
    if slug == "valores-distintos":
        return str(len(set(values[1:])))
    if slug == "rotar-arreglo":
        offset = values[1] % n
        array = values[2:]
        return " ".join(map(str, array[offset:] + array[:offset]))
    if slug == "consultas-suma":
        prefix = [0]
        for value in values[2 : n + 2]:
            prefix.append(prefix[-1] + value)
        queries = values[n + 2 :]
        return "\n".join(
            str(prefix[right] - prefix[left - 1])
            for left, right in zip(queries[::2], queries[1::2])
        )
    if slug == "producto-punto":
        return str(sum(a * b for a, b in zip(values[1 : n + 1], values[n + 1 :])))
    if slug == "primer-suficiente":
        index = bisect_left(values[2:], values[1])
        return str(index + 1 if index < n else -1)
    if slug == "tramo-limitado":
        left = total = best = 0
        array = values[2:]
        for right, value in enumerate(array):
            total += value
            while total > values[1]:
                total -= array[left]
                left += 1
            best = max(best, right - left + 1)
        return str(best)
    if slug == "agenda-compatible":
        intervals = sorted(zip(values[1::2], values[2::2]), key=lambda pair: (pair[1], pair[0]))
        last = -(10**30)
        selected = 0
        for start, end in intervals:
            if start >= last:
                selected += 1
                last = end
        return str(selected)
    if slug == "par-objetivo":
        left, right = 2, n + 1
        while left < right:
            total = values[left] + values[right]
            if total == values[1]:
                return "SI"
            if total < values[1]:
                left += 1
            else:
                right -= 1
        return "NO"
    if slug == "maximo-ventana":
        width = values[1]
        array = values[2:]
        total = best = sum(array[:width])
        for i in range(width, n):
            total += array[i] - array[i - width]
            best = max(best, total)
        return str(best)
    if slug == "suma-submatriz":
        rows, columns, count = values[:3]
        matrix_prefix = [[0] * (columns + 1) for _ in range(rows + 1)]
        offset = 3
        for r in range(1, rows + 1):
            for c in range(1, columns + 1):
                matrix_prefix[r][c] = (
                    values[offset]
                    + matrix_prefix[r - 1][c]
                    + matrix_prefix[r][c - 1]
                    - matrix_prefix[r - 1][c - 1]
                )
                offset += 1
        answers = []
        for _ in range(count):
            top, left, bottom, right = values[offset : offset + 4]
            answers.append(
                str(
                    matrix_prefix[bottom][right]
                    - matrix_prefix[top - 1][right]
                    - matrix_prefix[bottom][left - 1]
                    + matrix_prefix[top - 1][left - 1]
                )
            )
            offset += 4
        return "\n".join(answers)
    if slug == "racha-consecutiva":
        numbers = set(values[1:])
        best = 0
        for start in numbers:
            if start - 1 not in numbers:
                end = start
                while end in numbers:
                    end += 1
                best = max(best, end - start)
        return str(best)
    if slug == "cambio-minimo":
        dp = [0] + [n + 1] * n
        for amount in range(1, n + 1):
            dp[amount] = min(
                (dp[amount - coin] + 1 for coin in values[2:] if coin <= amount), default=n + 1
            )
        return str(dp[n] if dp[n] <= n else -1)
    if slug == "mochila-01":
        capacity = values[1]
        dp = [0] * (capacity + 1)
        for weight, worth in zip(values[2::2], values[3::2]):
            for room in range(capacity, weight - 1, -1):
                dp[room] = max(dp[room], dp[room - weight] + worth)
        return str(dp[capacity])
    if slug == "camino-minimo":
        count, edges, source, target = values[:4]
        graph: list[list[tuple[int, int]]] = [[] for _ in range(count + 1)]
        for i in range(edges):
            a, b, weight = values[4 + 3 * i : 7 + 3 * i]
            graph[a].append((b, weight))
            graph[b].append((a, weight))
        distance = [10**30] * (count + 1)
        distance[source] = 0
        pending_heap = [(0, source)]
        while pending_heap:
            cost, vertex = heappop(pending_heap)
            if cost != distance[vertex]:
                continue
            for other, weight in graph[vertex]:
                if cost + weight < distance[other]:
                    distance[other] = cost + weight
                    heappush(pending_heap, (cost + weight, other))
        return str(distance[target] if distance[target] < 10**30 else -1)
    if slug == "escaleras":
        dp = [1] + [0] * n
        for step in range(1, n + 1):
            dp[step] = sum(dp[step - jump] for jump in (1, 2, 3) if jump <= step) % 1_000_000_007
        return str(dp[n])
    if slug == "orden-topologico":
        graph_nodes: list[list[int]] = [[] for _ in range(n + 1)]
        indegree = [0] * (n + 1)
        for a, b in zip(values[2::2], values[3::2]):
            graph_nodes[a].append(b)
            indegree[b] += 1
        ready: list[int] = []
        for vertex in range(1, n + 1):
            if indegree[vertex] == 0:
                heappush(ready, vertex)
        order = []
        while ready:
            vertex = heappop(ready)
            order.append(vertex)
            for other in graph_nodes[vertex]:
                indegree[other] -= 1
                if indegree[other] == 0:
                    heappush(ready, other)
        return " ".join(map(str, order)) if len(order) == n else "IMPOSIBLE"
    if slug == "subsecuencia-creciente":
        tails: list[int] = []
        for value in values[1:]:
            index = bisect_left(tails, value)
            if index == len(tails):
                tails.append(value)
            else:
                tails[index] = value
        return str(len(tails))
    if slug == "reparto-cargas":
        tasks = values[2:]
        low, high = max(tasks), sum(tasks)
        while low < high:
            limit = (low + high) // 2
            used, total = 1, 0
            for task in tasks:
                if total + task > limit:
                    used += 1
                    total = 0
                total += task
            if used <= values[1]:
                high = limit
            else:
                low = limit + 1
        return str(low)
    if slug == "componentes-grafo":
        parents = list(range(n + 1))

        def root(vertex: int) -> int:
            while parents[vertex] != vertex:
                parents[vertex] = parents[parents[vertex]]
                vertex = parents[vertex]
            return vertex

        components = n
        for a, b in zip(values[2::2], values[3::2]):
            a, b = root(a), root(b)
            if a != b:
                parents[a] = b
                components -= 1
        return str(components)
    raise ValueError("Reto sin referencia autorizada")


if __name__ == "__main__":
    print(solve("__PROBLEM_SLUG__", sys.stdin.read().split()))
