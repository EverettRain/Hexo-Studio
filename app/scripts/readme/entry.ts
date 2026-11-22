// The mock backend first: the app asks it for its preferences as soon as it loads.
import { play } from "./mock";
import "@/main";

void play();
