/**
 * Catálogo de problemas piloto para calibración y semillas (doc 07 § Catálogo conceptual).
 *
 * Cuatro problemas piloto aprobados:
 * 1. suma-parcial (Muy fácil): Suma de una secuencia de enteros
 * 2. parentesis (Fácil): Balance de paréntesis, corchetes y llaves
 * 3. consultas-suma (Fácil-medio): Consultas de suma en rangos [L, R]
 * 4. fibonacci (Muy fácil): Cálculo del n-ésimo número de Fibonacci
 *
 * Invariantes (doc 07 § Aceptación):
 * - Enunciado claro en español con entrada, salida y restricciones.
 * - Exactamente 2 ejemplos públicos (is_example: true, ordinales 0 y 1).
 * - Exactamente 10 casos ocultos de evaluación (is_example: false, ordinales 2 a 11).
 * - Salida única y determinista sin checkers especiales.
 */
import type { SeedProblem } from './types.js';

export const PILOT_PROBLEMS: readonly SeedProblem[] = [
  {
    slug: 'suma-parcial',
    title: 'Suma parcial',
    category: 'muy_facil',
    description: `Dado un arreglo de N números enteros, calcula la suma de todos sus elementos.

### Entrada
La primera línea contiene un número entero N (1 <= N <= 1000).
La segunda línea contiene N números enteros separados por espacio (-10^6 <= A[i] <= 10^6).

### Salida
Un único número entero que representa la suma total de los elementos.`,
    time_limit_ms: 2000,
    memory_limit_mb: 256,
    version: 1,
    origin: {
      kind: 'original',
      url: null,
      license: 'MIT',
      attribution: 'DueloDev Team',
      verification_status: 'verified',
    },
    test_cases: [
      // 2 ejemplos públicos
      { ordinal: 0, input: '5\n1 2 3 4 5\n', expected_output: '15\n', is_example: true },
      { ordinal: 1, input: '3\n-10 20 -5\n', expected_output: '5\n', is_example: true },
      // 10 casos ocultos de evaluación
      { ordinal: 2, input: '1\n42\n', expected_output: '42\n', is_example: false },
      { ordinal: 3, input: '1\n-99\n', expected_output: '-99\n', is_example: false },
      { ordinal: 4, input: '1\n0\n', expected_output: '0\n', is_example: false },
      { ordinal: 5, input: '5\n0 0 0 0 0\n', expected_output: '0\n', is_example: false },
      { ordinal: 6, input: '4\n-1 -2 -3 -4\n', expected_output: '-10\n', is_example: false },
      {
        ordinal: 7,
        input: '6\n10 -10 20 -20 30 -30\n',
        expected_output: '0\n',
        is_example: false,
      },
      {
        ordinal: 8,
        input: '4\n1000000 1000000 1000000 1000000\n',
        expected_output: '4000000\n',
        is_example: false,
      },
      {
        ordinal: 9,
        input: '3\n-1000000 -1000000 -1000000\n',
        expected_output: '-3000000\n',
        is_example: false,
      },
      {
        ordinal: 10,
        input: '8\n100 -50 25 -10 5 -1 0 1\n',
        expected_output: '70\n',
        is_example: false,
      },
      {
        ordinal: 11,
        input: `10\n1 1 1 1 1 1 1 1 1 1\n`,
        expected_output: '10\n',
        is_example: false,
      },
    ],
  },
  {
    slug: 'parentesis',
    title: 'Balance de paréntesis',
    category: 'facil',
    description: `Dada una cadena compuesta exclusivamente por los caracteres '(', ')', '[', ']', '{' y '}', determina si los paréntesis están correctamente balanceados y cerrados en el orden apropiado.

### Entrada
Una única línea con una cadena de texto S (1 <= |S| <= 1000).

### Salida
Imprime "VALIDO" si la secuencia está correctamente balanceada, o "INVALIDO" en caso contrario.`,
    time_limit_ms: 2000,
    memory_limit_mb: 256,
    version: 1,
    origin: {
      kind: 'original',
      url: null,
      license: 'MIT',
      attribution: 'DueloDev Team',
      verification_status: 'verified',
    },
    test_cases: [
      // 2 ejemplos públicos
      { ordinal: 0, input: '()[{}]\n', expected_output: 'VALIDO\n', is_example: true },
      { ordinal: 1, input: '(]\n', expected_output: 'INVALIDO\n', is_example: true },
      // 10 casos ocultos de evaluación
      { ordinal: 2, input: '(\n', expected_output: 'INVALIDO\n', is_example: false },
      { ordinal: 3, input: ')\n', expected_output: 'INVALIDO\n', is_example: false },
      { ordinal: 4, input: '{[()]}\n', expected_output: 'VALIDO\n', is_example: false },
      { ordinal: 5, input: '([)]\n', expected_output: 'INVALIDO\n', is_example: false },
      { ordinal: 6, input: ')(()\n', expected_output: 'INVALIDO\n', is_example: false },
      { ordinal: 7, input: '(()\n', expected_output: 'INVALIDO\n', is_example: false },
      {
        ordinal: 8,
        input: '{()}[{}](){[]}\n',
        expected_output: 'VALIDO\n',
        is_example: false,
      },
      {
        ordinal: 9,
        input: '{()}[{}](){[\n',
        expected_output: 'INVALIDO\n',
        is_example: false,
      },
      {
        ordinal: 10,
        input: '(((([[{{{}}}]]))))\n',
        expected_output: 'VALIDO\n',
        is_example: false,
      },
      {
        ordinal: 11,
        input: '(((([[{{{}}]]))))\n',
        expected_output: 'INVALIDO\n',
        is_example: false,
      },
    ],
  },
  {
    slug: 'consultas-suma',
    title: 'Consultas de suma',
    category: 'facil_medio',
    description: `Dado un arreglo de N números enteros y Q consultas de rango [L, R] (1-indexadas), calcula para cada consulta la suma de los elementos desde el índice L hasta el índice R inclusive.

### Entrada
La primera línea contiene dos enteros N y Q (1 <= N, Q <= 10^5).
La segunda línea contiene N enteros A[1], A[2], ..., A[N] (-10^6 <= A[i] <= 10^6).
Las siguientes Q líneas contienen dos enteros L y R cada una (1 <= L <= R <= N).

### Salida
Para cada consulta, imprime la suma resultante en una línea separada.`,
    time_limit_ms: 2000,
    memory_limit_mb: 256,
    version: 1,
    origin: {
      kind: 'original',
      url: null,
      license: 'MIT',
      attribution: 'DueloDev Team',
      verification_status: 'verified',
    },
    test_cases: [
      // 2 ejemplos públicos
      {
        ordinal: 0,
        input: '5 3\n1 2 3 4 5\n1 3\n2 4\n1 5\n',
        expected_output: '6\n9\n15\n',
        is_example: true,
      },
      {
        ordinal: 1,
        input: '4 2\n-5 10 -2 8\n1 2\n3 4\n',
        expected_output: '5\n6\n',
        is_example: true,
      },
      // 10 casos ocultos de evaluación
      { ordinal: 2, input: '1 1\n100\n1 1\n', expected_output: '100\n', is_example: false },
      {
        ordinal: 3,
        input: '4 3\n3 7 2 9\n1 1\n2 2\n4 4\n',
        expected_output: '3\n7\n9\n',
        is_example: false,
      },
      {
        ordinal: 4,
        input: '3 1\n5 10 15\n1 3\n',
        expected_output: '30\n',
        is_example: false,
      },
      {
        ordinal: 5,
        input: '4 2\n-1 -2 -3 -4\n1 2\n1 4\n',
        expected_output: '-3\n-10\n',
        is_example: false,
      },
      {
        ordinal: 6,
        input: '5 2\n0 0 5 0 0\n1 2\n1 5\n',
        expected_output: '0\n5\n',
        is_example: false,
      },
      {
        ordinal: 7,
        input: '6 3\n2 4 6 8 10 12\n2 4\n3 5\n4 6\n',
        expected_output: '18\n24\n30\n',
        is_example: false,
      },
      {
        ordinal: 8,
        input: '3 2\n1000000 1000000 1000000\n1 2\n1 3\n',
        expected_output: '2000000\n3000000\n',
        is_example: false,
      },
      {
        ordinal: 9,
        input: '4 2\n10 -10 20 -20\n1 2\n1 4\n',
        expected_output: '0\n0\n',
        is_example: false,
      },
      {
        ordinal: 10,
        input: '5 1\n1 2 3 4 5\n4 5\n',
        expected_output: '9\n',
        is_example: false,
      },
      {
        ordinal: 11,
        input: '3 2\n10 20 30\n2 3\n2 3\n',
        expected_output: '50\n50\n',
        is_example: false,
      },
    ],
  },
  {
    slug: 'fibonacci',
    title: 'Número de Fibonacci',
    category: 'muy_facil',
    description: `La secuencia de Fibonacci se define de la siguiente manera:
F(0) = 0
F(1) = 1
F(N) = F(N-1) + F(N-2) para N >= 2

Dado un entero N, calcula F(N).

### Entrada
Una única línea que contiene un número entero N (0 <= N <= 40).

### Salida
El n-ésimo número de la secuencia de Fibonacci.`,
    time_limit_ms: 2000,
    memory_limit_mb: 256,
    version: 1,
    origin: {
      kind: 'original',
      url: null,
      license: 'MIT',
      attribution: 'DueloDev Team',
      verification_status: 'verified',
    },
    test_cases: [
      { ordinal: 0, input: '0\n', expected_output: '0\n', is_example: true },
      { ordinal: 1, input: '5\n', expected_output: '5\n', is_example: true },
      { ordinal: 2, input: '1\n', expected_output: '1\n', is_example: false },
      { ordinal: 3, input: '2\n', expected_output: '1\n', is_example: false },
      { ordinal: 4, input: '3\n', expected_output: '2\n', is_example: false },
      { ordinal: 5, input: '4\n', expected_output: '3\n', is_example: false },
      { ordinal: 6, input: '6\n', expected_output: '8\n', is_example: false },
      { ordinal: 7, input: '10\n', expected_output: '55\n', is_example: false },
      { ordinal: 8, input: '20\n', expected_output: '6765\n', is_example: false },
      { ordinal: 9, input: '30\n', expected_output: '832040\n', is_example: false },
      { ordinal: 10, input: '39\n', expected_output: '63245986\n', is_example: false },
      { ordinal: 11, input: '40\n', expected_output: '102334155\n', is_example: false },
    ],
  },
];
