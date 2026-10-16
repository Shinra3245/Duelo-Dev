// Referencias privadas: ejecutar exclusivamente en la VM rootless del juez.
#include <algorithm>
#include <climits>
#include <iostream>
#include <numeric>
#include <queue>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
using namespace std;
using i64 = long long;
constexpr string_view slug = "__PROBLEM_SLUG__";

string joined(const vector<i64>& values) {
    ostringstream out;
    for (size_t i = 0; i < values.size(); ++i) {
        if (i) out << ' ';
        out << values[i];
    }
    return out.str();
}

string solve(const vector<string>& tokens) {
    const string& word = tokens.at(0);
#if defined(REF_parentesis)
    if constexpr (slug == "parentesis") {
        string stack;
        const string opens = "([{", closes = ")]}";
        for (char c : word) {
            if (opens.find(c) != string::npos) stack += c;
            else {
                if (stack.empty() || stack.back() != opens.at(closes.find(c))) return "INVALIDO";
                stack.pop_back();
            }
        }
        return stack.empty() ? "VALIDO" : "INVALIDO";
    }
#endif
#if defined(REF_palindromo)
    if constexpr (slug == "palindromo") return word == string(word.rbegin(), word.rend()) ? "SI" : "NO";
#endif
#if defined(REF_contar_vocales)
    if constexpr (slug == "contar-vocales") {
        int count = 0;
        for (char c : word) count += string("aeiou").find(c) != string::npos;
        return to_string(count);
    }
#endif
#if defined(REF_invertir_palabra)
    if constexpr (slug == "invertir-palabra") return string(word.rbegin(), word.rend());
#endif
#if defined(REF_suma_digitos)
    if constexpr (slug == "suma-digitos") {
        i64 sum = 0;
        for (char c : word) sum += c - '0';
        return to_string(sum);
    }
#endif
#if defined(REF_subsecuencia_comun)
    if constexpr (slug == "subsecuencia-comun") {
        const string& other = tokens.at(1);
        vector<int> previous(other.size() + 1);
        for (char c : word) {
            vector<int> current(other.size() + 1);
            for (size_t j = 1; j <= other.size(); ++j)
                current[j] = c == other[j - 1] ? previous[j - 1] + 1 : max(previous[j], current[j - 1]);
            previous = move(current);
        }
        return to_string(previous.back());
    }
#endif
#if defined(REF_camino_corto) || defined(REF_cuadrado_unos)
    if constexpr (slug == "camino-corto" || slug == "cuadrado-unos") {
        int rows = stoi(word), cols = stoi(tokens.at(1));
        if constexpr (slug == "cuadrado-unos") {
            vector<int> previous(cols + 1);
            int best = 0;
            for (int r = 0; r < rows; ++r) {
                vector<int> current(cols + 1);
                for (int c = 1; c <= cols; ++c) if (tokens.at(r + 2)[c - 1] == '1') {
                    current[c] = 1 + min({previous[c], previous[c - 1], current[c - 1]});
                    best = max(best, current[c]);
                }
                previous = move(current);
            }
            return to_string(best);
        }
        vector<vector<int>> distance(rows, vector<int>(cols, -1));
        queue<pair<int, int>> pending;
        for (int r = 0; r < rows; ++r) for (int c = 0; c < cols; ++c)
            if (tokens.at(r + 2)[c] == 'S') { pending.emplace(r, c); distance[r][c] = 0; }
        const int dr[] = {1, -1, 0, 0}, dc[] = {0, 0, 1, -1};
        while (!pending.empty()) {
            auto [r, c] = pending.front(); pending.pop();
            if (tokens.at(r + 2)[c] == 'E') return to_string(distance[r][c]);
            for (int d = 0; d < 4; ++d) {
                int nr = r + dr[d], nc = c + dc[d];
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols &&
                    tokens.at(nr + 2)[nc] != '#' && distance[nr][nc] == -1) {
                    distance[nr][nc] = distance[r][c] + 1;
                    pending.emplace(nr, nc);
                }
            }
        }
        return "-1";
    }
#endif

    vector<i64> a;
    for (const string& token : tokens) a.push_back(stoll(token));
    int n = static_cast<int>(a.at(0));
#if defined(REF_contar_pares)
    if constexpr (slug == "contar-pares") return to_string(count_if(a.begin() + 1, a.end(), [](i64 v){ return v % 2 == 0; }));
#endif
#if defined(REF_mayor_posicion)
    if constexpr (slug == "mayor-posicion") {
        auto best = max_element(a.begin() + 1, a.end());
        return to_string(*best) + " " + to_string(best - a.begin());
    }
#endif
#if defined(REF_reloj_segundos)
    if constexpr (slug == "reloj-segundos") return to_string(a[0] * 3600 + a[1] * 60 + a[2]);
#endif
#if defined(REF_valores_distintos)
    if constexpr (slug == "valores-distintos") return to_string(set<i64>(a.begin() + 1, a.end()).size());
#endif
#if defined(REF_rotar_arreglo)
    if constexpr (slug == "rotar-arreglo") {
        vector<i64> values(a.begin() + 2, a.end());
        rotate(values.begin(), values.begin() + a[1] % n, values.end());
        return joined(values);
    }
#endif
#if defined(REF_consultas_suma)
    if constexpr (slug == "consultas-suma") {
        vector<i64> prefix(n + 1);
        for (int i = 1; i <= n; ++i) prefix[i] = prefix[i - 1] + a[i + 1];
        string out;
        for (size_t i = n + 2; i < a.size(); i += 2) out += to_string(prefix[a[i + 1]] - prefix[a[i] - 1]) + "\n";
        return out;
    }
#endif
#if defined(REF_producto_punto)
    if constexpr (slug == "producto-punto") {
        i64 total = 0;
        for (int i = 0; i < n; ++i) total += a[i + 1] * a[n + i + 1];
        return to_string(total);
    }
#endif
#if defined(REF_primer_suficiente)
    if constexpr (slug == "primer-suficiente") {
        auto found = lower_bound(a.begin() + 2, a.end(), a[1]);
        return to_string(found == a.end() ? -1 : found - a.begin() - 1);
    }
#endif
#if defined(REF_tramo_limitado)
    if constexpr (slug == "tramo-limitado") {
        int left = 2, best = 0;
        i64 total = 0;
        for (int right = 2; right < n + 2; ++right) {
            total += a[right];
            while (total > a[1]) total -= a[left++];
            best = max(best, right - left + 1);
        }
        return to_string(best);
    }
#endif
#if defined(REF_agenda_compatible)
    if constexpr (slug == "agenda-compatible") {
        vector<pair<i64, i64>> intervals;
        for (int i = 0; i < n; ++i) intervals.emplace_back(a[2 + 2 * i], a[1 + 2 * i]);
        sort(intervals.begin(), intervals.end());
        i64 last = LLONG_MIN;
        int selected = 0;
        for (auto [end, start] : intervals) if (start >= last) { ++selected; last = end; }
        return to_string(selected);
    }
#endif
#if defined(REF_par_objetivo)
    if constexpr (slug == "par-objetivo") {
        int left = 2, right = n + 1;
        while (left < right) {
            i64 sum = a[left] + a[right];
            if (sum == a[1]) return "SI";
            if (sum < a[1]) ++left; else --right;
        }
        return "NO";
    }
#endif
#if defined(REF_maximo_ventana)
    if constexpr (slug == "maximo-ventana") {
        int width = static_cast<int>(a[1]);
        i64 total = accumulate(a.begin() + 2, a.begin() + 2 + width, 0LL), best = total;
        for (int i = width; i < n; ++i) { total += a[i + 2] - a[i + 2 - width]; best = max(best, total); }
        return to_string(best);
    }
#endif
#if defined(REF_suma_submatriz)
    if constexpr (slug == "suma-submatriz") {
        int rows = n, cols = static_cast<int>(a[1]), offset = 3;
        vector<vector<i64>> prefix(rows + 1, vector<i64>(cols + 1));
        for (int r = 1; r <= rows; ++r) for (int c = 1; c <= cols; ++c)
            prefix[r][c] = a[offset++] + prefix[r - 1][c] + prefix[r][c - 1] - prefix[r - 1][c - 1];
        string out;
        for (int i = 0; i < a[2]; ++i) {
            int top = a[offset++], left = a[offset++], bottom = a[offset++], right = a[offset++];
            out += to_string(prefix[bottom][right] - prefix[top - 1][right] - prefix[bottom][left - 1] + prefix[top - 1][left - 1]) + "\n";
        }
        return out;
    }
#endif
#if defined(REF_racha_consecutiva)
    if constexpr (slug == "racha-consecutiva") {
        set<i64> numbers(a.begin() + 1, a.end());
        int best = 0;
        for (i64 start : numbers) if (!numbers.count(start - 1)) {
            i64 end = start;
            while (numbers.count(end)) ++end;
            best = max(best, static_cast<int>(end - start));
        }
        return to_string(best);
    }
#endif
#if defined(REF_cambio_minimo)
    if constexpr (slug == "cambio-minimo") {
        vector<int> dp(n + 1, n + 1); dp[0] = 0;
        for (int amount = 1; amount <= n; ++amount)
            for (size_t i = 2; i < a.size(); ++i) if (a[i] <= amount) dp[amount] = min(dp[amount], dp[amount - a[i]] + 1);
        return to_string(dp[n] <= n ? dp[n] : -1);
    }
#endif
#if defined(REF_mochila_01)
    if constexpr (slug == "mochila-01") {
        int capacity = static_cast<int>(a[1]);
        vector<i64> dp(capacity + 1);
        for (int i = 0; i < n; ++i) for (int room = capacity; room >= a[2 + 2 * i]; --room)
            dp[room] = max(dp[room], dp[room - a[2 + 2 * i]] + a[3 + 2 * i]);
        return to_string(dp[capacity]);
    }
#endif
#if defined(REF_camino_minimo)
    if constexpr (slug == "camino-minimo") {
        vector<vector<pair<int, i64>>> graph(n + 1);
        for (int i = 0; i < a[1]; ++i) {
            int x = a[4 + 3 * i], y = a[5 + 3 * i]; i64 weight = a[6 + 3 * i];
            graph[x].emplace_back(y, weight); graph[y].emplace_back(x, weight);
        }
        const i64 inf = LLONG_MAX / 4;
        vector<i64> distance(n + 1, inf);
        priority_queue<pair<i64, int>, vector<pair<i64, int>>, greater<pair<i64, int>>> pending;
        distance[a[2]] = 0; pending.emplace(0, a[2]);
        while (!pending.empty()) {
            auto [cost, vertex] = pending.top(); pending.pop();
            if (cost != distance[vertex]) continue;
            for (auto [other, weight] : graph[vertex]) if (cost + weight < distance[other]) {
                distance[other] = cost + weight; pending.emplace(distance[other], other);
            }
        }
        return to_string(distance[a[3]] == inf ? -1 : distance[a[3]]);
    }
#endif
#if defined(REF_escaleras)
    if constexpr (slug == "escaleras") {
        vector<i64> dp(n + 1); dp[0] = 1;
        for (int step = 1; step <= n; ++step) for (int jump = 1; jump <= 3 && jump <= step; ++jump)
            dp[step] = (dp[step] + dp[step - jump]) % 1000000007;
        return to_string(dp[n]);
    }
#endif
#if defined(REF_orden_topologico)
    if constexpr (slug == "orden-topologico") {
        vector<vector<int>> graph(n + 1);
        vector<int> indegree(n + 1);
        for (int i = 0; i < a[1]; ++i) { graph[a[2 + 2 * i]].push_back(a[3 + 2 * i]); ++indegree[a[3 + 2 * i]]; }
        priority_queue<int, vector<int>, greater<int>> ready;
        for (int v = 1; v <= n; ++v) if (!indegree[v]) ready.push(v);
        vector<i64> order;
        while (!ready.empty()) {
            int v = ready.top(); ready.pop(); order.push_back(v);
            for (int other : graph[v]) if (--indegree[other] == 0) ready.push(other);
        }
        return order.size() == static_cast<size_t>(n) ? joined(order) : "IMPOSIBLE";
    }
#endif
#if defined(REF_subsecuencia_creciente)
    if constexpr (slug == "subsecuencia-creciente") {
        vector<i64> tails;
        for (int i = 1; i <= n; ++i) {
            auto found = lower_bound(tails.begin(), tails.end(), a[i]);
            if (found == tails.end()) tails.push_back(a[i]); else *found = a[i];
        }
        return to_string(tails.size());
    }
#endif
#if defined(REF_reparto_cargas)
    if constexpr (slug == "reparto-cargas") {
        i64 low = *max_element(a.begin() + 2, a.end()), high = accumulate(a.begin() + 2, a.end(), 0LL);
        while (low < high) {
            i64 limit = low + (high - low) / 2, total = 0, used = 1;
            for (int i = 2; i < n + 2; ++i) { if (total + a[i] > limit) { ++used; total = 0; } total += a[i]; }
            if (used <= a[1]) high = limit; else low = limit + 1;
        }
        return to_string(low);
    }
#endif
#if defined(REF_componentes_grafo)
    if constexpr (slug == "componentes-grafo") {
        vector<int> parents(n + 1); iota(parents.begin(), parents.end(), 0);
        auto root = [&](int v) { while (parents[v] != v) { parents[v] = parents[parents[v]]; v = parents[v]; } return v; };
        int count = n;
        for (int i = 0; i < a[1]; ++i) {
            int x = root(a[2 + 2 * i]), y = root(a[3 + 2 * i]);
            if (x != y) { parents[x] = y; --count; }
        }
        return to_string(count);
    }
#endif
    throw invalid_argument("Reto sin referencia autorizada");
}

int main() {
    ios::sync_with_stdio(false); cin.tie(nullptr);
    vector<string> tokens;
    for (string token; cin >> token;) tokens.push_back(token);
    string answer = solve(tokens);
    cout << answer;
    if (answer.empty() || answer.back() != '\n') cout << '\n';
}
