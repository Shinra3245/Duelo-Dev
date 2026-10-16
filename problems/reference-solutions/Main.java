// Referencias privadas: ejecutar exclusivamente en la VM rootless del juez.
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.Collectors;

public class Main {
    private static String joined(List<? extends Number> values) {
        return values.stream().map(Object::toString).collect(Collectors.joining(" "));
    }

    private static int root(int[] parents, int vertex) {
        while (parents[vertex] != vertex) {
            parents[vertex] = parents[parents[vertex]];
            vertex = parents[vertex];
        }
        return vertex;
    }

    private static String solve(String slug, String[] tokens) {
        String word = tokens[0];
        if (slug.equals("parentesis")) {
            Deque<Character> stack = new ArrayDeque<>();
            String opens = "([{", closes = ")]}";
            for (char c : word.toCharArray()) {
                if (opens.indexOf(c) >= 0) stack.push(c);
                else if (stack.isEmpty() || stack.pop() != opens.charAt(closes.indexOf(c))) return "INVALIDO";
            }
            return stack.isEmpty() ? "VALIDO" : "INVALIDO";
        }
        if (slug.equals("palindromo")) return word.contentEquals(new StringBuilder(word).reverse()) ? "SI" : "NO";
        if (slug.equals("contar-vocales")) return Long.toString(word.chars().filter(c -> "aeiou".indexOf(c) >= 0).count());
        if (slug.equals("invertir-palabra")) return new StringBuilder(word).reverse().toString();
        if (slug.equals("suma-digitos")) return Integer.toString(word.chars().map(c -> c - '0').sum());
        if (slug.equals("subsecuencia-comun")) {
            String other = tokens[1];
            int[] previous = new int[other.length() + 1];
            for (char c : word.toCharArray()) {
                int[] current = new int[previous.length];
                for (int j = 1; j <= other.length(); j++)
                    current[j] = c == other.charAt(j - 1) ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
                previous = current;
            }
            return Integer.toString(previous[other.length()]);
        }
        if (slug.equals("camino-corto") || slug.equals("cuadrado-unos")) {
            int rows = Integer.parseInt(word), cols = Integer.parseInt(tokens[1]);
            if (slug.equals("cuadrado-unos")) {
                int[] previous = new int[cols + 1];
                int best = 0;
                for (int r = 0; r < rows; r++) {
                    int[] current = new int[cols + 1];
                    for (int c = 1; c <= cols; c++) if (tokens[r + 2].charAt(c - 1) == '1') {
                        current[c] = 1 + Math.min(previous[c], Math.min(previous[c - 1], current[c - 1]));
                        best = Math.max(best, current[c]);
                    }
                    previous = current;
                }
                return Integer.toString(best);
            }
            int[][] distance = new int[rows][cols];
            for (int[] row : distance) Arrays.fill(row, -1);
            Deque<int[]> pending = new ArrayDeque<>();
            for (int r = 0; r < rows; r++) for (int c = 0; c < cols; c++) if (tokens[r + 2].charAt(c) == 'S') {
                pending.add(new int[]{r, c}); distance[r][c] = 0;
            }
            int[] dr = {1, -1, 0, 0}, dc = {0, 0, 1, -1};
            while (!pending.isEmpty()) {
                int[] cell = pending.remove(); int r = cell[0], c = cell[1];
                if (tokens[r + 2].charAt(c) == 'E') return Integer.toString(distance[r][c]);
                for (int d = 0; d < 4; d++) {
                    int nr = r + dr[d], nc = c + dc[d];
                    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && tokens[nr + 2].charAt(nc) != '#' && distance[nr][nc] == -1) {
                        distance[nr][nc] = distance[r][c] + 1; pending.add(new int[]{nr, nc});
                    }
                }
            }
            return "-1";
        }

        long[] a = Arrays.stream(tokens).mapToLong(Long::parseLong).toArray();
        int n = (int) a[0];
        switch (slug) {
            case "contar-pares": return Long.toString(Arrays.stream(a, 1, a.length).filter(v -> v % 2 == 0).count());
            case "mayor-posicion": {
                int best = 1;
                for (int i = 2; i <= n; i++) if (a[i] > a[best]) best = i;
                return a[best] + " " + best;
            }
            case "reloj-segundos": return Long.toString(a[0] * 3600 + a[1] * 60 + a[2]);
            case "valores-distintos": return Long.toString(Arrays.stream(a, 1, a.length).distinct().count());
            case "rotar-arreglo": {
                List<Long> out = new ArrayList<>();
                for (int i = 0; i < n; i++) out.add(a[2 + (int) ((i + a[1]) % n)]);
                return joined(out);
            }
            case "consultas-suma": {
                long[] prefix = new long[n + 1];
                for (int i = 1; i <= n; i++) prefix[i] = prefix[i - 1] + a[i + 1];
                StringBuilder out = new StringBuilder();
                for (int i = n + 2; i < a.length; i += 2) out.append(prefix[(int) a[i + 1]] - prefix[(int) a[i] - 1]).append('\n');
                return out.toString();
            }
            case "producto-punto": {
                long total = 0;
                for (int i = 0; i < n; i++) total += a[i + 1] * a[n + i + 1];
                return Long.toString(total);
            }
            case "primer-suficiente": {
                int left = 2, right = n + 2;
                while (left < right) {
                    int mid = (left + right) >>> 1;
                    if (a[mid] < a[1]) left = mid + 1; else right = mid;
                }
                return Integer.toString(left == n + 2 ? -1 : left - 1);
            }
            case "tramo-limitado": {
                int left = 2, best = 0; long total = 0;
                for (int right = 2; right < n + 2; right++) {
                    total += a[right];
                    while (total > a[1]) total -= a[left++];
                    best = Math.max(best, right - left + 1);
                }
                return Integer.toString(best);
            }
            case "agenda-compatible": {
                long[][] intervals = new long[n][2];
                for (int i = 0; i < n; i++) { intervals[i][0] = a[1 + 2 * i]; intervals[i][1] = a[2 + 2 * i]; }
                Arrays.sort(intervals, Comparator.<long[]>comparingLong(p -> p[1]).thenComparingLong(p -> p[0]));
                long last = Long.MIN_VALUE; int selected = 0;
                for (long[] interval : intervals) if (interval[0] >= last) { selected++; last = interval[1]; }
                return Integer.toString(selected);
            }
            case "par-objetivo": {
                int left = 2, right = n + 1;
                while (left < right) {
                    long total = a[left] + a[right];
                    if (total == a[1]) return "SI";
                    if (total < a[1]) left++; else right--;
                }
                return "NO";
            }
            case "maximo-ventana": {
                int width = (int) a[1];
                long total = Arrays.stream(a, 2, 2 + width).sum(), best = total;
                for (int i = width; i < n; i++) { total += a[i + 2] - a[i + 2 - width]; best = Math.max(best, total); }
                return Long.toString(best);
            }
            case "suma-submatriz": {
                int cols = (int) a[1], offset = 3;
                long[][] prefix = new long[n + 1][cols + 1];
                for (int r = 1; r <= n; r++) for (int c = 1; c <= cols; c++)
                    prefix[r][c] = a[offset++] + prefix[r - 1][c] + prefix[r][c - 1] - prefix[r - 1][c - 1];
                StringBuilder out = new StringBuilder();
                for (int i = 0; i < a[2]; i++) {
                    int top = (int) a[offset++], left = (int) a[offset++], bottom = (int) a[offset++], right = (int) a[offset++];
                    out.append(prefix[bottom][right] - prefix[top - 1][right] - prefix[bottom][left - 1] + prefix[top - 1][left - 1]).append('\n');
                }
                return out.toString();
            }
            case "racha-consecutiva": {
                Set<Long> numbers = new HashSet<>();
                for (int i = 1; i <= n; i++) numbers.add(a[i]);
                long best = 0;
                for (long start : numbers) if (!numbers.contains(start - 1)) {
                    long end = start;
                    while (numbers.contains(end)) end++;
                    best = Math.max(best, end - start);
                }
                return Long.toString(best);
            }
            case "cambio-minimo": {
                int[] dp = new int[n + 1]; Arrays.fill(dp, n + 1); dp[0] = 0;
                for (int amount = 1; amount <= n; amount++) for (int i = 2; i < a.length; i++)
                    if (a[i] <= amount) dp[amount] = Math.min(dp[amount], dp[amount - (int) a[i]] + 1);
                return Integer.toString(dp[n] <= n ? dp[n] : -1);
            }
            case "mochila-01": {
                int capacity = (int) a[1]; long[] dp = new long[capacity + 1];
                for (int i = 0; i < n; i++) for (int room = capacity; room >= a[2 + 2 * i]; room--)
                    dp[room] = Math.max(dp[room], dp[room - (int) a[2 + 2 * i]] + a[3 + 2 * i]);
                return Long.toString(dp[capacity]);
            }
            case "camino-minimo": {
                List<List<long[]>> graph = new ArrayList<>();
                for (int i = 0; i <= n; i++) graph.add(new ArrayList<>());
                for (int i = 0; i < a[1]; i++) {
                    int x = (int) a[4 + 3 * i], y = (int) a[5 + 3 * i]; long weight = a[6 + 3 * i];
                    graph.get(x).add(new long[]{y, weight}); graph.get(y).add(new long[]{x, weight});
                }
                long[] distance = new long[n + 1]; Arrays.fill(distance, Long.MAX_VALUE / 4);
                distance[(int) a[2]] = 0;
                PriorityQueue<long[]> pending = new PriorityQueue<>(Comparator.comparingLong(p -> p[0]));
                pending.add(new long[]{0, a[2]});
                while (!pending.isEmpty()) {
                    long[] item = pending.remove(); long cost = item[0]; int vertex = (int) item[1];
                    if (cost != distance[vertex]) continue;
                    for (long[] edge : graph.get(vertex)) if (cost + edge[1] < distance[(int) edge[0]]) {
                        distance[(int) edge[0]] = cost + edge[1]; pending.add(new long[]{cost + edge[1], edge[0]});
                    }
                }
                long answer = distance[(int) a[3]];
                return Long.toString(answer == Long.MAX_VALUE / 4 ? -1 : answer);
            }
            case "escaleras": {
                long[] dp = new long[n + 1]; dp[0] = 1;
                for (int step = 1; step <= n; step++) for (int jump = 1; jump <= 3 && jump <= step; jump++)
                    dp[step] = (dp[step] + dp[step - jump]) % 1_000_000_007;
                return Long.toString(dp[n]);
            }
            case "orden-topologico": {
                List<List<Integer>> graph = new ArrayList<>();
                for (int i = 0; i <= n; i++) graph.add(new ArrayList<>());
                int[] indegree = new int[n + 1];
                for (int i = 0; i < a[1]; i++) { graph.get((int) a[2 + 2 * i]).add((int) a[3 + 2 * i]); indegree[(int) a[3 + 2 * i]]++; }
                PriorityQueue<Integer> ready = new PriorityQueue<>();
                for (int v = 1; v <= n; v++) if (indegree[v] == 0) ready.add(v);
                List<Integer> order = new ArrayList<>();
                while (!ready.isEmpty()) {
                    int vertex = ready.remove(); order.add(vertex);
                    for (int other : graph.get(vertex)) if (--indegree[other] == 0) ready.add(other);
                }
                return order.size() == n ? joined(order) : "IMPOSIBLE";
            }
            case "subsecuencia-creciente": {
                long[] tails = new long[n]; int size = 0;
                for (int i = 1; i <= n; i++) {
                    int left = 0, right = size;
                    while (left < right) { int mid = (left + right) >>> 1; if (tails[mid] < a[i]) left = mid + 1; else right = mid; }
                    tails[left] = a[i]; if (left == size) size++;
                }
                return Integer.toString(size);
            }
            case "reparto-cargas": {
                long low = Arrays.stream(a, 2, a.length).max().orElseThrow(), high = Arrays.stream(a, 2, a.length).sum();
                while (low < high) {
                    long limit = low + (high - low) / 2, total = 0; int used = 1;
                    for (int i = 2; i < n + 2; i++) { if (total + a[i] > limit) { used++; total = 0; } total += a[i]; }
                    if (used <= a[1]) high = limit; else low = limit + 1;
                }
                return Long.toString(low);
            }
            case "componentes-grafo": {
                int[] parents = new int[n + 1]; for (int i = 0; i <= n; i++) parents[i] = i;
                int count = n;
                for (int i = 0; i < a[1]; i++) {
                    int x = root(parents, (int) a[2 + 2 * i]), y = root(parents, (int) a[3 + 2 * i]);
                    if (x != y) { parents[x] = y; count--; }
                }
                return Integer.toString(count);
            }
            default: throw new IllegalArgumentException("Reto sin referencia autorizada");
        }
    }

    public static void main(String[] args) throws Exception {
        String input = new String(System.in.readAllBytes(), StandardCharsets.UTF_8).trim();
        String answer = solve("__PROBLEM_SLUG__", input.split("\\s+"));
        System.out.print(answer);
        if (!answer.endsWith("\n")) System.out.println();
    }
}
