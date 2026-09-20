import { describe, expect, it } from 'vitest';
import { ADDITIONAL_PROBLEMS } from '../src/seeds/active-problems.js';

const tokens = (input: string) => input.trim().split(/\s+/);

function referenceOutput(slug: string, input: string): string {
  const data = tokens(input);
  const values = data.map(Number);
  const output = (value: number | string) => `${value}\n`;

  switch (slug) {
    case 'contar-pares':
      return output(values.slice(1).filter((value) => value % 2 === 0).length);
    case 'mayor-posicion': {
      const best = Math.max(...values.slice(1));
      return output(`${best} ${values.slice(1).indexOf(best) + 1}`);
    }
    case 'reloj-segundos':
      return output(values[0]! * 3600 + values[1]! * 60 + values[2]!);
    case 'contar-vocales':
      return output([...data[0]!].filter((character) => 'aeiou'.includes(character)).length);
    case 'valores-distintos':
      return output(new Set(values.slice(1)).size);
    case 'invertir-palabra':
      return output([...data[0]!].reverse().join(''));
    case 'suma-digitos':
      return output([...data[0]!].reduce((sum, digit) => sum + Number(digit), 0));
    case 'rotar-arreglo': {
      const count = values[0]!;
      const offset = values[1]! % count;
      const array = values.slice(2);
      return output([...array.slice(offset), ...array.slice(0, offset)].join(' '));
    }
    case 'primer-suficiente': {
      const target = values[1]!;
      const index = values.slice(2).findIndex((value) => value >= target!);
      return output(index < 0 ? -1 : index + 1);
    }
    case 'tramo-limitado': {
      const count = values[0]!;
      const limit = values[1]!;
      const array = values.slice(2, 2 + count);
      let left = 0;
      let sum = 0;
      let best = 0;
      array.forEach((value, right) => {
        sum += value;
        while (sum > limit) sum -= array[left++]!;
        best = Math.max(best, right - left + 1);
      });
      return output(best);
    }
    case 'camino-corto': {
      const rows = values[0]!;
      const columns = values[1]!;
      const grid = data.slice(2, 2 + rows).map((row) => [...row!]);
      const start = grid.flatMap((row, r) =>
        row.map((cell, c) => (cell === 'S' ? [r, c] : [])),
      )[0]!;
      const distance = Array.from({ length: rows }, () => Array(columns).fill(-1));
      const queue: Array<[number, number]> = [[start[0] as number, start[1] as number]];
      distance[start[0] as number]![start[1] as number] = 0;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const [row, column] = queue[cursor]!;
        if (grid[row]![column] === 'E') return output(distance[row]![column]);
        for (const [dr, dc] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nextRow = row + dr!;
          const nextColumn = column + dc!;
          if (
            nextRow >= 0 &&
            nextRow < rows &&
            nextColumn >= 0 &&
            nextColumn < columns &&
            grid[nextRow]![nextColumn] !== '#' &&
            distance[nextRow]![nextColumn] === -1
          ) {
            distance[nextRow]![nextColumn] = distance[row]![column] + 1;
            queue.push([nextRow, nextColumn]);
          }
        }
      }
      return output(-1);
    }
    case 'agenda-compatible': {
      const count = values[0]!;
      const intervals = Array.from(
        { length: count },
        (_, index) => [values[1 + index * 2]!, values[2 + index * 2]!] as const,
      ).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      let lastEnd = Number.NEGATIVE_INFINITY;
      let selected = 0;
      for (const [start, end] of intervals) {
        if (start >= lastEnd) {
          selected++;
          lastEnd = end;
        }
      }
      return output(selected);
    }
    case 'par-objetivo': {
      const count = values[0]!;
      const target = values[1]!;
      const array = values.slice(2, 2 + count);
      let left = 0;
      let right = array.length - 1;
      while (left < right) {
        const sum = array[left]! + array[right]!;
        if (sum === target) return output('SI');
        if (sum < target) left++;
        else right--;
      }
      return output('NO');
    }
    case 'maximo-ventana': {
      const count = values[0]!;
      const size = values[1]!;
      const array = values.slice(2, 2 + count);
      let sum = array.slice(0, size).reduce((total, value) => total + value, 0);
      let best = sum;
      for (let end = size; end < count; end++) {
        sum += array[end]! - array[end - size]!;
        best = Math.max(best, sum);
      }
      return output(best);
    }
    case 'suma-submatriz': {
      const [rows, columns, queryCount] = values;
      let index = 3;
      const matrix = Array.from({ length: rows! }, () => values.slice(index, (index += columns!)));
      const answers: number[] = [];
      for (let query = 0; query < queryCount!; query++) {
        const top = values[index++]! - 1;
        const left = values[index++]! - 1;
        const bottom = values[index++]! - 1;
        const right = values[index++]! - 1;
        let sum = 0;
        for (let row = top; row <= bottom; row++) {
          for (let column = left; column <= right; column++) {
            sum += Number(matrix[row]![column]);
          }
        }
        answers.push(sum);
      }
      return `${answers.join('\n')}\n`;
    }
    case 'racha-consecutiva': {
      const set = new Set(values.slice(1));
      let best = 0;
      for (const value of set) {
        if (!set.has(value - 1)) {
          let length = 1;
          while (set.has(value + length)) length++;
          best = Math.max(best, length);
        }
      }
      return output(best);
    }
    case 'cambio-minimo': {
      const amount = values[0]!;
      const count = values[1]!;
      const coins = values.slice(2, 2 + count);
      const dp = Array(amount + 1).fill(Number.POSITIVE_INFINITY);
      dp[0] = 0;
      for (let value = 1; value <= amount; value++) {
        for (const coin of coins) {
          if (coin! <= value) dp[value] = Math.min(dp[value], dp[value - coin!] + 1);
        }
      }
      return output(Number.isFinite(dp[amount]) ? dp[amount] : -1);
    }
    case 'mochila-01': {
      const count = values[0]!;
      const capacity = values[1]!;
      const dp = Array(capacity + 1).fill(0);
      for (let index = 0; index < count; index++) {
        const weight = values[2 + index * 2]!;
        const worth = values[3 + index * 2]!;
        for (let room = capacity; room >= weight; room--) {
          dp[room] = Math.max(dp[room], dp[room - weight]! + worth);
        }
      }
      return output(dp[capacity]);
    }
    case 'subsecuencia-comun': {
      const first = data[0]!;
      const second = data[1]!;
      let previous = Array(second.length + 1).fill(0);
      for (const left of first) {
        const current = Array(second.length + 1).fill(0);
        for (let index = 1; index <= second.length; index++) {
          current[index] =
            left === second[index - 1]
              ? previous[index - 1]! + 1
              : Math.max(previous[index]!, current[index - 1]!);
        }
        previous = current;
      }
      return output(previous[second.length]);
    }
    case 'camino-minimo': {
      const [count, edgeCount, source, target] = values;
      const graph: Array<Array<[number, number]>> = Array.from({ length: count! }, () => []);
      let index = 4;
      for (let edge = 0; edge < edgeCount!; edge++) {
        const left = values[index++]! - 1;
        const right = values[index++]! - 1;
        const weight = values[index++]!;
        graph[left]!.push([right, weight]);
        graph[right]!.push([left, weight]);
      }
      const distance = Array(count).fill(Number.POSITIVE_INFINITY);
      const visited = Array(count).fill(false);
      distance[source! - 1] = 0;
      for (let step = 0; step < count!; step++) {
        let current = -1;
        for (let vertex = 0; vertex < count!; vertex++) {
          if (!visited[vertex] && (current < 0 || distance[vertex]! < distance[current]!)) {
            current = vertex;
          }
        }
        if (current < 0 || !Number.isFinite(distance[current])) break;
        visited[current] = true;
        for (const [next, weight] of graph[current]!) {
          distance[next] = Math.min(distance[next]!, distance[current]! + weight);
        }
      }
      const answer = distance[target! - 1]!;
      return output(Number.isFinite(answer) ? answer : -1);
    }
    case 'escaleras': {
      const n = values[0]!;
      const dp = Array(n + 1).fill(0);
      dp[0] = 1;
      for (let step = 1; step <= n; step++) {
        dp[step] =
          ((dp[step - 1] ?? 0) + (dp[step - 2] ?? 0) + (dp[step - 3] ?? 0)) % 1_000_000_007;
      }
      return output(dp[n]);
    }
    case 'orden-topologico': {
      const [count, edgeCount] = values;
      const graph: number[][] = Array.from({ length: count! }, () => []);
      const indegree = Array(count).fill(0);
      let index = 2;
      for (let edge = 0; edge < edgeCount!; edge++) {
        const from = values[index++]! - 1;
        const to = values[index++]! - 1;
        graph[from]!.push(to);
        indegree[to]++;
      }
      const ready = indegree
        .map((degree, vertex) => (degree === 0 ? vertex : -1))
        .filter((v) => v >= 0);
      const order: number[] = [];
      while (ready.length > 0) {
        ready.sort((a, b) => a - b);
        const vertex = ready.shift()!;
        order.push(vertex + 1);
        for (const next of graph[vertex]!) {
          indegree[next]--;
          if (indegree[next] === 0) ready.push(next);
        }
      }
      return output(order.length === count ? order.join(' ') : 'IMPOSIBLE');
    }
    case 'cuadrado-unos': {
      const [rows, columns] = values;
      const grid = data.slice(2, 2 + rows!).map((row) => [...row!].map(Number));
      let previous = Array(columns! + 1).fill(0);
      let best = 0;
      for (let row = 0; row < rows!; row++) {
        const current = Array(columns! + 1).fill(0);
        for (let column = 1; column <= columns!; column++) {
          if (grid[row]![column - 1] === 1) {
            current[column] =
              Math.min(previous[column]!, current[column - 1]!, previous[column - 1]!) + 1;
            best = Math.max(best, current[column]!);
          }
        }
        previous = current;
      }
      return output(best);
    }
    case 'subsecuencia-creciente': {
      const count = values[0]!;
      const tails: number[] = [];
      for (const value of values.slice(1, count + 1)) {
        let left = 0;
        let right = tails.length;
        while (left < right) {
          const middle = Math.floor((left + right) / 2);
          if (tails[middle]! < value!) left = middle + 1;
          else right = middle;
        }
        tails[left] = value!;
      }
      return output(tails.length);
    }
    case 'reparto-cargas': {
      const count = values[0]!;
      const groups = values[1]!;
      const tasks = values.slice(2, count + 2);
      let low = tasks.reduce((largest, task) => Math.max(largest, task), 0);
      let high = tasks.reduce((sum, task) => sum + task, 0);
      const requiredGroups = (limit: number) => {
        let used = 1;
        let sum = 0;
        for (const task of tasks) {
          if (sum + task! > limit) {
            used++;
            sum = 0;
          }
          sum += task!;
        }
        return used;
      };
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (requiredGroups(middle) <= groups) high = middle;
        else low = middle + 1;
      }
      return output(low);
    }
    case 'componentes-grafo': {
      const [count, edgeCount] = values;
      const parent = Array.from({ length: count! }, (_, index) => index);
      const find = (value: number): number => {
        if (parent[value] !== value) parent[value] = find(parent[value]!);
        return parent[value]!;
      };
      let index = 2;
      for (let edge = 0; edge < edgeCount!; edge++) {
        const left = find(values[index++]! - 1);
        const right = find(values[index++]! - 1);
        parent[left] = right;
      }
      return output(new Set(parent.map((_, vertex) => find(vertex))).size);
    }
    default:
      throw new Error(`No existe referencia confiable para ${slug}`);
  }
}

describe('integridad de casos del catálogo activo', () => {
  it.each(ADDITIONAL_PROBLEMS)('$slug: valida sus dos ejemplos y diez casos ocultos', (problem) => {
    expect(problem.test_cases).toHaveLength(12);
    for (const testCase of problem.test_cases) {
      expect(referenceOutput(problem.slug, testCase.input), `caso ${testCase.ordinal}`).toBe(
        testCase.expected_output,
      );
    }
  });
});
