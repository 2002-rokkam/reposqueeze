<template>
  <div class="todo-app">
    <h1>{{ title }}</h1>
    <ul class="todo-list">
      <li v-for="todo in todos" :key="todo.id" :class="{ done: todo.done }">
        <input type="checkbox" v-model="todo.done">
        <span>{{ todo.text }}</span>
        <button @click="remove(todo.id)">Remove</button>
      </li>
    </ul>
    <form @submit.prevent="add">
      <input v-model="draft" placeholder="What needs doing?">
      <button type="submit">Add</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

interface Todo { id: number; text: string; done: boolean }

const title = ref('Todos');
const todos = ref<Todo[]>([]);
const draft = ref('');

function add() {
  todos.value.push({ id: Date.now(), text: draft.value, done: false });
  draft.value = '';
}

function remove(id: number) {
  todos.value = todos.value.filter(t => t.id !== id);
}
</script>

<style scoped lang="scss">
.todo-app {
  max-width: 32rem;
  margin: 0 auto;
}
.done span {
  text-decoration: line-through;
}
</style>
